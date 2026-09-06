/**
 * The run engine: the loop that turns a prepared run into an audit.
 *
 * For each sample, in a pool of MAX_CONCURRENCY workers:
 *
 *   1. Phrase the opening question with the model and update the turn-1 row.
 *      (Deterministic template text is already stored, so this only ever makes
 *      the question read better; a model failure leaves the template standing.)
 *   2. Ask the accountant: defend(sample) gathers evidence deterministically
 *      and writes one paragraph. Persist it as an accountant turn carrying the
 *      whole EvidenceBundle.
 *   3. Ask the deterministic follow-up policy what to do with that bundle:
 *        accept    -> the sample is defended, done.
 *        escalate  -> the sample is a gap, and only gaps reach the controller.
 *        push_back -> persist the auditor's follow-up as the next turn and go
 *                     back to step 2 with that follow-up in the accountant's
 *                     context, up to MAX_TURNS turns.
 *
 * Two rules keep the loop honest and bounded:
 *
 *   - MAX_TURNS. decide() escalates at turn 3 on its own; the cap here is the
 *     belt to that braces, so a policy change can never produce a sample that
 *     loops forever.
 *   - Repeat detection. gatherEvidence is deterministic, so a second pass over
 *     the same sample returns the same rows and the same gaps unless the
 *     auditor's follow-up actually moved something. When the accountant comes
 *     back with an identical evidence signature, pushing back again could only
 *     produce the same answer a third time, so the sample escalates to the
 *     controller instead of burning a turn. The follow-up and the accountant's
 *     confirmation are both still on the record.
 *
 * Nothing here decides anything with a model: defend() is the only model call,
 * and it only writes prose over rows that were already found.
 *
 * Two entry points over one loop:
 *
 *   runAudit(runId)      Works the run to the end. The CLI path, where the
 *                        process lives as long as the run does.
 *   runAuditStep(runId)  Works the run for a bounded slice of time and a
 *                        bounded number of samples, then returns progress.
 *                        The path for a host that kills the process when the
 *                        response ends (Vercel), where a fire-and-forget loop
 *                        would leave a run stalled at progress 0: the client
 *                        calls it repeatedly until status is "complete".
 *
 * Both are safe to run concurrently against the same run, and against each
 * other. A sample is only ever worked after it has been claimed by an atomic
 * UPDATE ... WHERE status = 'open' AND the lease is free ... RETURNING, so two
 * overlapping advance calls divide the work rather than duplicating it.
 */
import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { defend } from "@/lib/accountant";
import { withSampleCitation } from "@/lib/auditor/citation";
import { loadSampleDetail } from "@/lib/auditor/detail";
import type { EvidenceBundle, SampleType } from "@/lib/auditor/evidence-types";
import { phraseQuestion } from "@/lib/auditor/llm";
import { decide } from "@/lib/auditor/policy";
import { chooseQuestion, procedureFor } from "@/lib/auditor/questions";
import { withRunTrace, withSampleSpan } from "@/lib/tracing";
import type { SampleCandidate } from "@/lib/auditor/sampler";
import { toCents } from "@/lib/auditor/util";

/** Samples worked on at once. Enough to keep the screen moving, small enough
 * to stay well inside the database pool (max 5) and polite to the model. */
export const MAX_CONCURRENCY = 4;

/** Hard cap on accountant turns per sample, per pass. */
export const MAX_TURNS = 3;

/**
 * How long a claim on a sample is honoured before another worker may take it.
 * Generous next to a sample's real cost (three model calls at a 30s timeout is
 * the worst case) so a slow sample is never stolen from a live worker, and
 * short enough that a sample stranded by a killed process comes back on the
 * next advance call rather than pinning the run open forever.
 */
export const CLAIM_LEASE_MS = 180_000;

/** Defaults for one bounded step, tuned under a 30s serverless response cap. */
export const STEP_BUDGET_MS = 20_000;
export const STEP_MAX_SAMPLES = 4;

export type SampleOutcome = {
  auditSampleId: number;
  type: SampleType;
  sampleId: number;
  status: "defended" | "gap";
  turns: number;
  citations: number;
  gaps: number;
};

export type RunAuditResult = {
  runId: number;
  processed: number;
  defended: number;
  gaps: number;
  failed: number;
  outcomes: SampleOutcome[];
};

export type RunAuditOptions = {
  concurrency?: number;
  /** Called after each sample settles, for CLI progress output. */
  onSettled?: (outcome: SampleOutcome) => void;
};

export type RunStepOptions = RunAuditOptions & {
  /** Stop claiming new samples once this much wall clock has been spent. */
  budgetMs?: number;
  /** Stop claiming new samples once this many have settled in this step. */
  maxSamples?: number;
};

/** What one bounded step reports back, and what the advance route returns. */
export type RunStepResult = {
  runId: number;
  progress: number;
  sampleCount: number;
  /** running | complete | failed */
  status: string;
  /** Samples settled by this step alone. */
  settled: number;
  /** True when nothing is left to claim, i.e. no further step is needed. */
  done: boolean;
  failed: number;
};

type SampleRow = typeof schema.auditSamples.$inferSelect;
type ExchangeRow = typeof schema.auditExchanges.$inferSelect;

export async function runAudit(
  runId: number,
  options: RunAuditOptions = {},
): Promise<RunAuditResult> {
  const run = await requireRun(runId);
  const { outcomes, failed } = await withRunTrace({ runId, name: run.name }, () =>
    workClaimedSamples(runId, options),
  );
  await finalizeRunStatus(runId);

  outcomes.sort((a, b) => a.auditSampleId - b.auditSampleId);
  return {
    runId,
    processed: outcomes.length,
    defended: outcomes.filter((o) => o.status === "defended").length,
    gaps: outcomes.filter((o) => o.status === "gap").length,
    failed,
    outcomes,
  };
}

/**
 * One bounded slice of the same loop. Settles what it can inside `budgetMs`
 * and `maxSamples`, then reports where the run stands so the caller can decide
 * whether to call again. Never throws for a run that exists: a sample that
 * fails is left open for the next step, exactly as in runAudit.
 */
export async function runAuditStep(
  runId: number,
  options: RunStepOptions = {},
): Promise<RunStepResult> {
  const run = await requireRun(runId);
  const budgetMs = options.budgetMs ?? STEP_BUDGET_MS;
  const maxSamples = options.maxSamples ?? STEP_MAX_SAMPLES;

  const { outcomes, failed } = await withRunTrace({ runId, name: run.name }, () =>
    workClaimedSamples(runId, {
      ...options,
      // Never start more workers than samples this step is allowed to settle.
      concurrency: Math.min(options.concurrency ?? MAX_CONCURRENCY, maxSamples),
      budgetMs,
      maxSamples,
    }),
  );
  const status = await finalizeRunStatus(runId);

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      settled: sql<number>`count(*) filter (where ${schema.auditSamples.status} <> 'open')::int`,
    })
    .from(schema.auditSamples)
    .where(eq(schema.auditSamples.runId, runId));

  return {
    runId,
    progress: counts.settled,
    sampleCount: counts.total,
    status,
    settled: outcomes.length,
    done: counts.settled >= counts.total,
    failed,
  };
}

async function requireRun(runId: number): Promise<{ id: number; name: string }> {
  const [run] = await db
    .select({ id: schema.auditRuns.id, name: schema.auditRuns.name })
    .from(schema.auditRuns)
    .where(eq(schema.auditRuns.id, runId));
  if (!run) throw new Error(`audit run #${runId} does not exist`);
  return run;
}

/**
 * The loop both entry points share. Workers claim a sample at a time and stop
 * when there is nothing left to claim, or when the step's budget or sample
 * quota runs out. Because claiming is atomic, the number of workers here is a
 * throughput knob and nothing more: it cannot affect correctness, and neither
 * can another process running this at the same time.
 */
async function workClaimedSamples(
  runId: number,
  options: RunStepOptions,
): Promise<{ outcomes: SampleOutcome[]; failed: number }> {
  const deadline = options.budgetMs === undefined ? Infinity : Date.now() + options.budgetMs;
  const quota = options.maxSamples ?? Infinity;

  const outcomes: SampleOutcome[] = [];
  let failed = 0;
  let claimed = 0;

  const workerCount = Math.max(1, Math.min(options.concurrency ?? MAX_CONCURRENCY, quota));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      // Checked before claiming, never after: a claimed sample is always
      // worked to a settled state, so a step can overrun its budget by at
      // most one sample rather than abandoning a claim it already took.
      if (Date.now() >= deadline || claimed >= quota) return;
      claimed++;

      const sample = await claimNextSample(runId);
      if (!sample) return;

      try {
        const outcome = await withSampleSpan(
          { type: sample.sampleType, id: sample.sampleId, auditSampleId: sample.id },
          () => workSample(runId, sample),
        );
        outcomes.push(outcome);
        options.onSettled?.(outcome);
      } catch (err) {
        // One sample failing is not the run failing. The claim is released so
        // the next pass can retry it, and it stays open, which is exactly what
        // "we did not finish testing this" should look like on the screen.
        failed++;
        await releaseClaim(sample.id);
        console.error(
          `[engine/run] sample #${sample.id} (${sample.sampleType}:${sample.sampleId}) failed:`,
          err,
        );
      }
    }
  });

  await Promise.all(workers);
  return { outcomes, failed };
}

/**
 * Takes the next unworked sample, atomically. The UPDATE ... RETURNING is the
 * whole concurrency story: whichever caller's statement lands first owns the
 * row, and the other gets a different row or nothing. FOR UPDATE SKIP LOCKED
 * on the inner select keeps two callers from queueing on the same candidate.
 */
async function claimNextSample(runId: number): Promise<SampleRow | null> {
  const rows = await db.execute<SampleRow>(sql`
    update audit_samples
       set claimed_at = now()
     where id = (
       select id
         from audit_samples
        where run_id = ${runId}
          and status = 'open'
          and (claimed_at is null or claimed_at < now() - ${`${CLAIM_LEASE_MS} milliseconds`}::interval)
        order by id
        limit 1
        for update skip locked
     )
    returning id, run_id as "runId", sample_type as "sampleType", sample_id as "sampleId",
              amount, risk_score as "riskScore", risk_reasons as "riskReasons", status,
              pending_follow_up as "pendingFollowUp", claimed_at as "claimedAt",
              created_at as "createdAt"
  `);
  return rows[0] ?? null;
}

async function releaseClaim(auditSampleId: number) {
  await db
    .update(schema.auditSamples)
    .set({ claimedAt: null })
    .where(eq(schema.auditSamples.id, auditSampleId));
}

/**
 * A run is complete exactly when nothing is open, evaluated in one statement.
 * Two overlapping steps can both finish here in either order — one having
 * exhausted its budget with samples still open, the other having settled the
 * last one — so the value has to be derived rather than asserted, or the
 * slower writer would clobber the faster one's verdict.
 */
async function finalizeRunStatus(runId: number): Promise<string> {
  const rows = await db.execute<{ status: string }>(sql`
    update audit_runs
       set status = case
             when (select count(*) from audit_samples
                    where run_id = ${runId} and status = 'open') = 0
             then 'complete' else 'running' end
     where id = ${runId}
    returning status
  `);
  return rows[0]?.status ?? "running";
}

/** One sample, start to settled. */
async function workSample(runId: number, sample: SampleRow): Promise<SampleOutcome> {
  const ref = { type: sample.sampleType as SampleType, id: sample.sampleId };
  const exchanges = await db
    .select()
    .from(schema.auditExchanges)
    .where(eq(schema.auditExchanges.sampleId, sample.id))
    .orderBy(asc(schema.auditExchanges.turn), asc(schema.auditExchanges.id));

  const procedure = openingProcedure(exchanges);
  const followUps: string[] = [];

  // A note the controller left on a "needs more" ruling is the auditor's
  // question for this pass, so it leads the accountant's context.
  if (sample.pendingFollowUp) followUps.push(sample.pendingFollowUp.trim());

  let turn = await openTurn(runId, sample, exchanges, procedure);

  let previousSignature: string | null = null;
  let accountantTurns = 0;
  let last: EvidenceBundle | null = null;

  for (let round = 1; round <= MAX_TURNS; round++) {
    const bundle = await defend(ref, { followUps });
    last = bundle;
    accountantTurns++;
    await db.insert(schema.auditExchanges).values({
      runId,
      sampleId: sample.id,
      turn,
      role: "accountant",
      content: bundle.defense ?? "(no defense written)",
      evidence: bundle,
    });

    const decision = decide(bundle, round);
    if (decision.action === "accept") {
      return settle(sample, "defended", accountantTurns, bundle);
    }
    if (decision.action === "escalate") {
      return settle(sample, "gap", accountantTurns, bundle);
    }

    // push_back
    const signature = evidenceSignature(bundle);
    if (previousSignature !== null && signature === previousSignature) {
      // The re-search returned exactly what it returned last time. A third
      // identical answer would tell the controller nothing new.
      return settle(sample, "gap", accountantTurns, bundle);
    }
    previousSignature = signature;

    if (round === MAX_TURNS) return settle(sample, "gap", accountantTurns, bundle);

    turn++;
    const followUp = decision.followUp ?? "Search again and cite a specific row for this item.";
    followUps.push(followUp);
    await db.insert(schema.auditExchanges).values({
      runId,
      sampleId: sample.id,
      turn,
      role: "auditor",
      procedure,
      content: withSampleCitation(followUp, { sampleType: ref.type, sampleId: ref.id }),
    });
  }

  // Unreachable: every path above returns. Kept so the types stay honest.
  return settle(sample, "gap", accountantTurns, last);
}

/**
 * The turn number the accountant answers on, and the auditor turn it answers.
 *
 * A fresh sample already has its turn-1 question, so the accountant replies on
 * turn 1. A sample the controller sent back has a complete thread behind it,
 * so this pass starts on the next turn — and if nothing has been said since
 * the last accountant turn (the ruling was not itself written to the thread),
 * the controller's note is written in as the auditor's question so the
 * transcript never shows an answer to nothing.
 */
async function openTurn(
  runId: number,
  sample: SampleRow,
  exchanges: ExchangeRow[],
  procedure: string | null,
): Promise<number> {
  const maxTurn = exchanges.reduce((max, e) => Math.max(max, e.turn), 0);
  const lastRole = exchanges.length > 0 ? exchanges[exchanges.length - 1].role : null;

  // Fresh sample: the opening question is already there, waiting for an answer.
  if (lastRole === "auditor") {
    await phraseOpeningQuestion(sample, exchanges);
    return Math.max(maxTurn, 1);
  }

  const turn = maxTurn + 1;
  if (lastRole !== "referee" && sample.pendingFollowUp) {
    await db.insert(schema.auditExchanges).values({
      runId,
      sampleId: sample.id,
      turn,
      role: "auditor",
      procedure,
      content: withSampleCitation(sample.pendingFollowUp.trim(), {
        sampleType: sample.sampleType as SampleType,
        sampleId: sample.sampleId,
      }),
    });
  }
  return turn;
}

/**
 * Rewrites the stored opening question in the model's words. The template text
 * persisted by prepareRun() is already correct and already cited; this is the
 * one place the auditor's prose is improved, and if the model is off or errors
 * phraseQuestion() hands the template straight back and nothing changes.
 */
async function phraseOpeningQuestion(sample: SampleRow, exchanges: ExchangeRow[]) {
  const opening = exchanges.find((e) => e.role === "auditor" && e.questionTemplateId !== null);
  if (!opening || exchanges.some((e) => e.role === "accountant")) return;

  const candidate: SampleCandidate = {
    sampleType: sample.sampleType as SampleType,
    sampleId: sample.sampleId,
    amountCents: toCents(sample.amount),
    date: "",
    cycle: "purchases", // unused by chooseQuestion; the detail row decides
    riskScore: sample.riskScore,
    riskReasons: sample.riskReasons,
  };
  const detail = await loadSampleDetail(candidate);
  const { templateId, text } = chooseQuestion(candidate, detail);
  // The stored procedure came from the stored template. If the facts behind
  // this sample have moved enough to select a different template, rewriting
  // the text would leave the question and its procedure describing different
  // work; leave the persisted question alone instead.
  if (templateId !== opening.questionTemplateId) return;
  const phrased = await phraseQuestion(text);
  const question = withSampleCitation(phrased, {
    sampleType: candidate.sampleType,
    sampleId: candidate.sampleId,
  });
  if (question === opening.content) return;
  await db
    .update(schema.auditExchanges)
    .set({ content: question })
    .where(eq(schema.auditExchanges.id, opening.id));
}

/** The procedure the run is testing this sample under, from its opening turn. */
function openingProcedure(exchanges: ExchangeRow[]): string | null {
  for (const e of exchanges) {
    if (e.role !== "auditor") continue;
    if (e.procedure) return e.procedure;
    if (e.questionTemplateId) {
      const fromTemplate = procedureFor(e.questionTemplateId);
      if (fromTemplate) return fromTemplate;
    }
  }
  return null;
}

/**
 * What the accountant found, reduced to the part the policy reads. Two passes
 * with the same signature cannot produce different policy decisions, which is
 * what makes another push-back pointless.
 */
function evidenceSignature(bundle: EvidenceBundle): string {
  const gaps = bundle.gaps
    .map((g) => `${g.kind}:${g.description}`)
    .sort()
    .join("|");
  const citations = bundle.citations
    .map((c) => `${c.table}#${c.id}:${c.field}`)
    .sort()
    .join("|");
  return `${gaps}##${citations}`;
}

async function settle(
  sample: SampleRow,
  status: "defended" | "gap",
  turns: number,
  bundle: EvidenceBundle | null,
): Promise<SampleOutcome> {
  await db
    .update(schema.auditSamples)
    // The note is consumed by this pass: clearing it is what stops the sample
    // being picked up again on the next run over the same run id. The claim
    // goes with it, so a sample the controller later reopens starts unclaimed.
    .set({ status, pendingFollowUp: null, claimedAt: null })
    .where(eq(schema.auditSamples.id, sample.id));

  // Recomputed rather than incremented. An increment is correct only if every
  // writer is in this process; a count is correct no matter how many advance
  // calls are running, and it cannot drift past sample_count.
  await db.execute(sql`
    update audit_runs
       set progress = (select count(*) from audit_samples
                        where run_id = ${sample.runId} and status <> 'open')
     where id = ${sample.runId}
  `);

  return {
    auditSampleId: sample.id,
    type: sample.sampleType as SampleType,
    sampleId: sample.sampleId,
    status,
    turns,
    citations: bundle?.citations.length ?? 0,
    gaps: bundle?.gaps.length ?? 0,
  };
}

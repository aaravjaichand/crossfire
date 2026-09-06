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
 */
import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { defend } from "@/lib/accountant";
import { withSampleCitation } from "@/lib/auditor/citation";
import { loadSampleDetail } from "@/lib/auditor/detail";
import type { EvidenceBundle, SampleType } from "@/lib/auditor/evidence-types";
import { phraseQuestion } from "@/lib/auditor/llm";
import { decide } from "@/lib/auditor/policy";
import { chooseQuestion, procedureFor } from "@/lib/auditor/questions";
import type { SampleCandidate } from "@/lib/auditor/sampler";
import { toCents } from "@/lib/auditor/util";

/** Samples worked on at once. Enough to keep the screen moving, small enough
 * to stay well inside the database pool (max 5) and polite to the model. */
export const MAX_CONCURRENCY = 4;

/** Hard cap on accountant turns per sample, per pass. */
export const MAX_TURNS = 3;

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

type SampleRow = typeof schema.auditSamples.$inferSelect;
type ExchangeRow = typeof schema.auditExchanges.$inferSelect;

export async function runAudit(
  runId: number,
  options: RunAuditOptions = {},
): Promise<RunAuditResult> {
  const [run] = await db.select().from(schema.auditRuns).where(eq(schema.auditRuns.id, runId));
  if (!run) throw new Error(`audit run #${runId} does not exist`);

  // Everything still open, plus anything the controller sent back for more
  // work (status is set back to "open" with a note, but a re-run should pick
  // it up even if that ordering ever changes).
  const samples = await db
    .select()
    .from(schema.auditSamples)
    .where(
      and(
        eq(schema.auditSamples.runId, runId),
        or(
          eq(schema.auditSamples.status, "open"),
          isNotNull(schema.auditSamples.pendingFollowUp),
        ),
      ),
    )
    .orderBy(asc(schema.auditSamples.id));

  // Progress counts settled samples, so it starts at everything this pass is
  // not going to touch. Derived from the working set rather than queried
  // separately, so a sample that is both settled and carrying a follow-up
  // cannot be counted twice and push progress past sample_count.
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.auditSamples)
    .where(eq(schema.auditSamples.runId, runId));

  await db
    .update(schema.auditRuns)
    .set({ status: "running", progress: Math.max(0, total - samples.length) })
    .where(eq(schema.auditRuns.id, runId));

  const outcomes: SampleOutcome[] = [];
  let failed = 0;

  const queue = [...samples];
  const workers = Array.from(
    { length: Math.max(1, Math.min(options.concurrency ?? MAX_CONCURRENCY, queue.length || 1)) },
    async () => {
      for (;;) {
        const sample = queue.shift();
        if (!sample) return;
        try {
          const outcome = await workSample(runId, sample);
          outcomes.push(outcome);
          await db
            .update(schema.auditRuns)
            .set({ progress: sql`${schema.auditRuns.progress} + 1` })
            .where(eq(schema.auditRuns.id, runId));
          options.onSettled?.(outcome);
        } catch (err) {
          // One sample failing is not the run failing. It stays open, which is
          // exactly what "we did not finish testing this" should look like.
          failed++;
          console.error(
            `[engine/run] sample #${sample.id} (${sample.sampleType}:${sample.sampleId}) failed:`,
            err,
          );
        }
      }
    },
  );

  try {
    await Promise.all(workers);
  } catch (err) {
    await db
      .update(schema.auditRuns)
      .set({ status: "failed" })
      .where(eq(schema.auditRuns.id, runId));
    throw err;
  }

  await db
    .update(schema.auditRuns)
    .set({ status: "complete" })
    .where(eq(schema.auditRuns.id, runId));

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
    // being picked up again on the next run over the same run id.
    .set({ status, pendingFollowUp: null })
    .where(eq(schema.auditSamples.id, sample.id));

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

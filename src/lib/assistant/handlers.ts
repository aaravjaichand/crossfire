/**
 * The ten tool handlers. Every one is plain code over the referee's read
 * helpers and drizzle: no free-form SQL, no table or column name crosses the
 * model boundary as an argument, and nothing here writes a row.
 *
 * The one write in the catalog, starting a run, lives in ./start-run.ts so
 * that this file never imports a "use server" module. assistant.check.ts
 * asserts that at the source level.
 *
 * Each handler returns { rows, citations, note?, resolvedRunId?, draft? }.
 * The rows are what the model reads and what the screen renders when the
 * model's prose does not check out; the citations are the rows the prose is
 * allowed to bracket.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { llmDisabled, llmForcedToFail } from "@/lib/accountant/defend";
import {
  counterpartyFor,
  describeGapKind,
  MEMORY_RESOLUTION,
  MEMORY_VERDICTS,
  memoryResolvedIds,
} from "@/lib/accountant/memory";
import { toCents } from "@/lib/accountant/money";
import type { Citation, SampleType } from "@/lib/accountant/types";
import { TABLE_BY_SAMPLE_TYPE } from "@/lib/auditor/citation";
import { complete, LLM_MODEL } from "@/lib/llm";
import { normalizeRunInput, parseCycles } from "@/lib/engine/inputs";
import { proposeAdjustment, type ProposedEntry } from "@/lib/referee/adjustments";
import {
  counterpartyOf,
  coverage,
  getRun,
  latestEvidence,
  MOCK_RUN_ID,
  primaryGap,
  type RunView,
  type SampleView,
} from "@/lib/referee/data";
import { normaliseNote } from "@/lib/referee/decide";
import { formatMoney } from "@/lib/referee/format";
import { recentRuns } from "@/lib/referee/runs";
import { formatSampleId, isSampleType, parseSampleId } from "@/lib/referee/sample-id";
import { isVerdict, REMEDY_LABEL, VERDICT_LABEL, type Verdict } from "@/lib/referee/verdicts";
import { traceLlmCall } from "@/lib/tracing";
import { finalizeAnswer } from "./answer";
import { DRAFT_SYSTEM_PROMPT } from "./prompt";
import { remedyFor } from "./remedies";
import {
  isDraftVerdict,
  type DraftVerdict,
  type RulingDraft,
  type StartRunDraft,
  type ToolArgs,
  type ToolResult,
  type ToolRow,
} from "./types";

// ---------- arguments ----------

export function str(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

export function int(args: ToolArgs, key: string): number | undefined {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function limitArg(args: ToolArgs, fallback: number, max = 50): number {
  const n = int(args, "limit");
  if (n === undefined || n <= 0) return fallback;
  return Math.min(n, max);
}

/**
 * The one place a `runId` argument is interpreted. A numeric string is taken
 * as given, "mock" is the walkthrough, and anything else — including omitted
 * — means the most recent run. Every run-scoped result echoes what this chose.
 */
export async function resolveRunArg(runId: unknown): Promise<string> {
  if (typeof runId === "number" && Number.isSafeInteger(runId) && runId > 0) return String(runId);
  if (typeof runId === "string") {
    const trimmed = runId.trim().replace(/^run\s*#?/i, "");
    if (/^\d+$/.test(trimmed)) return trimmed;
    if (trimmed.toLowerCase() === MOCK_RUN_ID || trimmed.toLowerCase() === "walkthrough") {
      return MOCK_RUN_ID;
    }
  }
  const [latest] = await recentRuns(1);
  return latest ? String(latest.id) : MOCK_RUN_ID;
}

async function loadRun(runId: unknown): Promise<{ runKey: string; run: RunView | null }> {
  const runKey = await resolveRunArg(runId);
  return { runKey, run: await getRun(runKey) };
}

function noRun(runKey: string): ToolResult {
  return { rows: [], citations: [], note: `There is no run ${runKey}.`, resolvedRunId: runKey };
}

// ---------- citations ----------

function sampleTable(type: SampleType): string {
  return TABLE_BY_SAMPLE_TYPE[type];
}

function sampleIdOf(sample: SampleView): number {
  return Number(sample.id.split(":")[1]);
}

function sampleCitation(sample: SampleView, reason?: string): Citation {
  return {
    table: sampleTable(sample.type),
    id: sampleIdOf(sample),
    field: "amount",
    value: formatMoney(sample.amount),
    reason: reason ?? `${sample.label}, ${sample.date}: ${sample.status}.`,
  };
}

function runCitation(run: RunView, reason: string): Citation | null {
  if (run.kind !== "real") return null;
  return {
    table: "audit_runs",
    id: Number(run.id),
    field: "name",
    value: run.name,
    reason,
  };
}

function sampleHref(runKey: string, sampleId: string): string {
  return `/audit/${encodeURIComponent(runKey)}?s=${encodeURIComponent(sampleId)}`;
}

function dedupe(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    const key = `${c.table}#${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function sameCounterparty(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function counterpartyMatches(sample: SampleView, wanted: string): boolean {
  const have = counterpartyOf(sample).toLowerCase();
  const want = wanted.trim().toLowerCase();
  return have === want || have.includes(want);
}

// ---------- 1. run_summary ----------

export async function runSummary(args: ToolArgs): Promise<ToolResult> {
  const { runKey, run } = await loadRun(args.runId);
  if (!run) return noRun(runKey);

  const { defended, total, percent } = coverage(run);
  const gaps = run.samples.filter((s) => s.status === "gap");
  const exceptions = gaps.filter((s) => s.ruling?.verdict === "exception").length;
  const conceded = run.samples.filter((s) => s.status === "conceded").length;
  const resolvedByMemory = (await memoryResolvedIds(runKey)).size;

  let seed: number | undefined;
  if (run.kind === "real") {
    const [row] = await db
      .select({ seed: schema.auditRuns.seed })
      .from(schema.auditRuns)
      .where(eq(schema.auditRuns.id, Number(run.id)));
    seed = row?.seed;
  }

  const row: ToolRow = {
    run: runKey,
    name: run.name,
    status: run.status ?? (run.kind === "mock" ? "walkthrough" : "complete"),
    samples: total,
    defended,
    resolvedByMemory,
    // Gaps still waiting on the controller, and the findings already ruled.
    gapsUnruled: gaps.filter((s) => !s.ruling).length,
    exceptions: exceptions + conceded,
    open: run.samples.filter((s) => s.status === "open").length,
    // The same expression coverage() in referee/data.ts and side() in
    // engine/comparison.ts use, never asked of the model.
    coveragePercent: percent,
    materiality: run.materiality === undefined ? null : formatMoney(run.materiality / 100),
    sampleSize: run.sampleSize ?? null,
    cycles: run.cycles?.join(", ") ?? null,
    seed: seed ?? null,
    progress: run.progress ?? null,
    href: `/audit/${encodeURIComponent(runKey)}`,
  };

  const citations: Citation[] = [];
  const cite = runCitation(
    run,
    `Run ${runKey}: ${defended} of ${total} samples defended (${percent}%), ${row.gapsUnruled} gaps unruled, ${row.exceptions} exceptions.`,
  );
  if (cite) citations.push(cite);
  else {
    // The walkthrough has no audit_runs row, so its summary rests on the
    // sampled rows themselves.
    for (const sample of run.samples.slice(0, 8)) citations.push(sampleCitation(sample));
  }
  return { rows: [row], citations, resolvedRunId: runKey };
}

// ---------- 2. list_gaps ----------

export async function listGaps(args: ToolArgs): Promise<ToolResult> {
  const { runKey, run } = await loadRun(args.runId);
  if (!run) return noRun(runKey);

  const kind = str(args, "kind")?.toLowerCase().replace(/[\s-]+/g, "_");
  const counterparty = str(args, "counterparty");
  const status = (str(args, "status") ?? "unruled").toLowerCase();
  const limit = limitArg(args, 10);

  let gaps = run.samples.filter((s) => s.status === "gap");
  if (kind) gaps = gaps.filter((s) => primaryGap(s).kind === kind);
  if (counterparty) gaps = gaps.filter((s) => counterpartyMatches(s, counterparty));
  if (status === "unruled") gaps = gaps.filter((s) => !s.ruling);
  else if (status === "ruled") gaps = gaps.filter((s) => Boolean(s.ruling));

  const shown = gaps.slice(0, limit);
  const rows: ToolRow[] = shown.map((s) => {
    const gap = primaryGap(s);
    return {
      sample: s.id,
      label: s.label,
      counterparty: counterpartyOf(s),
      amount: formatMoney(s.amount),
      date: s.date,
      gapKind: gap.kind,
      gapDescription: gap.description,
      verdict: s.ruling ? VERDICT_LABEL[s.ruling.verdict] : "unruled",
      href: sampleHref(runKey, s.id),
    };
  });
  const citations = shown.map((s) => {
    const gap = primaryGap(s);
    return sampleCitation(s, `${s.label}, ${s.date}: ${describeGapKind(gap.kind)}. ${gap.description}`);
  });
  const runCite = runCitation(run, `Run ${runKey}: ${gaps.length} ${gaps.length === 1 ? "gap" : "gaps"} matched.`);
  if (runCite) citations.push(runCite);

  const notes: string[] = [];
  if (gaps.length === 0) {
    notes.push(
      status === "unruled"
        ? `No gaps are waiting on a ruling in run ${runKey}${kind ? ` of kind ${kind}` : ""}${counterparty ? ` for ${counterparty}` : ""}.`
        : `No gaps matched in run ${runKey}.`,
    );
  } else if (gaps.length > shown.length) {
    notes.push(`Showing ${shown.length} of ${gaps.length} gaps.`);
  }
  return { rows, citations, resolvedRunId: runKey, ...(notes.length ? { note: notes.join(" ") } : {}) };
}

// ---------- 3. explain_sample ----------

type SampleContext = {
  runKey: string;
  run: RunView;
  sample: SampleView;
  entry: ProposedEntry;
  decisionId: number | null;
  resolvedByMemory: boolean;
};

async function loadSampleContext(args: ToolArgs): Promise<SampleContext | { error: ToolResult }> {
  const { runKey, run } = await loadRun(args.runId);
  if (!run) return { error: noRun(runKey) };
  const raw = str(args, "sampleRef") ?? str(args, "sample") ?? "";
  const ref = parseSampleId(raw);
  if (!ref) {
    return {
      error: {
        rows: [],
        citations: [],
        note: `"${raw}" is not a sample reference. Expected invoice:<id>, bank:<id>, or dodo:<id>.`,
        resolvedRunId: runKey,
      },
    };
  }
  const id = formatSampleId(ref);
  const sample = run.samples.find((s) => s.id === id);
  if (!sample) {
    return {
      error: { rows: [], citations: [], note: `Sample ${id} is not part of run ${runKey}.`, resolvedRunId: runKey },
    };
  }
  const gap = primaryGap(sample);
  const entry = proposeAdjustment({
    gapKind: gap.kind,
    sampleType: sample.type,
    sampleId: ref.id,
    sampleAmount: sample.amount,
    citations: latestEvidence(sample)?.citations ?? [],
    gapDescription: gap.description,
  });
  const decisionId = await latestDecisionId(runKey, sample);
  const resolvedByMemory = (await memoryResolvedIds(runKey)).has(id);
  return { runKey, run, sample, entry, decisionId, resolvedByMemory };
}

async function latestDecisionId(runKey: string, sample: SampleView): Promise<number | null> {
  const [row] = await db
    .select({ id: schema.refereeDecisions.id })
    .from(schema.refereeDecisions)
    .where(
      and(
        eq(schema.refereeDecisions.runId, runKey),
        eq(schema.refereeDecisions.sampleType, sample.type),
        eq(schema.refereeDecisions.sampleId, sampleIdOf(sample)),
      ),
    )
    .orderBy(desc(schema.refereeDecisions.id))
    .limit(1);
  return row?.id ?? null;
}

function decisionCitation(id: number, sample: SampleView): Citation | null {
  const ruling = sample.ruling;
  if (!ruling) return null;
  return {
    table: "referee_decisions",
    id,
    field: "decision",
    value: ruling.verdict,
    reason: `The controller's ${VERDICT_LABEL[ruling.verdict].toLowerCase()} ruling on ${sample.id}${ruling.note ? `: "${ruling.note}"` : "."}`,
  };
}

export async function explainSample(args: ToolArgs): Promise<ToolResult> {
  const ctx = await loadSampleContext(args);
  if ("error" in ctx) return ctx.error;
  const { runKey, sample, entry, decisionId, resolvedByMemory } = ctx;
  const evidence = latestEvidence(sample);
  const gap = primaryGap(sample);

  const summary: ToolRow = {
    sample: sample.id,
    label: sample.label,
    counterparty: counterpartyOf(sample),
    amount: formatMoney(sample.amount),
    date: sample.date,
    status: sample.status,
    gapKind: sample.status === "gap" || evidence?.gaps.length ? gap.kind : null,
    gapDescription: evidence?.gaps.map((g) => g.description).join(" ") || null,
    ruling: sample.ruling ? VERDICT_LABEL[sample.ruling.verdict] : null,
    rulingNote: sample.ruling?.note ?? null,
    rulingRemedy: sample.ruling?.remedy ? REMEDY_LABEL[sample.ruling.remedy] : null,
    resolvedByMemory,
    proposedDebit: entry.debit,
    proposedCredit: entry.credit,
    proposedAmount: entry.amount,
    proposedAmountSource: entry.amountSource,
    proposedMemo: entry.memo,
    proposedEntryFellBack: entry.fellBack,
    turns: sample.thread.length,
    href: sampleHref(runKey, sample.id),
  };
  const turns: ToolRow[] = sample.thread.map((m) => ({
    turn: m.turn,
    role: m.role,
    content: m.content,
    procedure: m.procedure ?? null,
  }));

  const citations: Citation[] = [sampleCitation(sample), ...(evidence?.citations ?? [])];
  const decision = decisionId === null ? null : decisionCitation(decisionId, sample);
  if (decision) citations.push(decision);
  const runCite = runCitation(ctx.run, `Run ${runKey}, which drew ${sample.id}.`);
  if (runCite) citations.push(runCite);

  return { rows: [summary, ...turns], citations: dedupe(citations), resolvedRunId: runKey };
}

// ---------- 4. exposure_by_counterparty ----------

/**
 * Money on samples the accountant could not defend, grouped by the string a
 * learned rule is filed under, so this and prior_rulings agree by
 * construction. A sample at status "gap" is either a finding the controller
 * ruled an exception on or a gap still waiting; a sufficient or accept-with-
 * note ruling moves it to defended and a needs-more reopens it, so the status
 * alone is the filter. Bank amounts are signed, so sums are taken at absolute
 * value in cents.
 */
export async function exposureByCounterparty(args: ToolArgs): Promise<ToolResult> {
  const { runKey, run } = await loadRun(args.runId);
  if (!run) return noRun(runKey);
  const limit = limitArg(args, 8);
  const wanted = str(args, "counterparty");

  const decisionRows = await db
    .select({
      id: schema.refereeDecisions.id,
      sampleType: schema.refereeDecisions.sampleType,
      sampleId: schema.refereeDecisions.sampleId,
      decision: schema.refereeDecisions.decision,
    })
    .from(schema.refereeDecisions)
    .where(eq(schema.refereeDecisions.runId, runKey))
    .orderBy(asc(schema.refereeDecisions.id));
  // Newest wins, as the run screen and recentRuns() decide it.
  const latestDecision = new Map<string, { id: number; verdict: string }>();
  for (const d of decisionRows) {
    if (!isSampleType(d.sampleType) || !isVerdict(d.decision)) continue;
    latestDecision.set(formatSampleId({ type: d.sampleType, id: d.sampleId }), { id: d.id, verdict: d.decision });
  }

  type Group = {
    counterparty: string;
    cents: number;
    exceptions: number;
    unruled: number;
    samples: SampleView[];
    decisionIds: number[];
  };
  const groups = new Map<string, Group>();
  for (const sample of run.samples) {
    if (sample.status !== "gap" && sample.status !== "conceded") continue;
    const counterparty = counterpartyOf(sample);
    if (wanted && !counterpartyMatches(sample, wanted)) continue;
    const g = groups.get(counterparty) ?? {
      counterparty,
      cents: 0,
      exceptions: 0,
      unruled: 0,
      samples: [],
      decisionIds: [],
    };
    g.cents += Math.abs(toCents(sample.amount));
    const decision = latestDecision.get(sample.id);
    if (decision?.verdict === "exception" || sample.status === "conceded") g.exceptions += 1;
    else if (!sample.ruling) g.unruled += 1;
    if (decision) g.decisionIds.push(decision.id);
    g.samples.push(sample);
    groups.set(counterparty, g);
  }

  const ranked = [...groups.values()].sort((a, b) => b.cents - a.cents).slice(0, limit);
  const rows: ToolRow[] = ranked.map((g) => ({
    counterparty: g.counterparty,
    totalAmount: formatMoney(g.cents / 100),
    gapCount: g.samples.length,
    exceptionCount: g.exceptions,
    unruledCount: g.unruled,
    sampleIds: g.samples.map((s) => s.id).join(", "),
    largest: formatMoney(Math.max(...g.samples.map((s) => Math.abs(Number(s.amount)))) ),
  }));
  const citations: Citation[] = [];
  for (const g of ranked) {
    for (const s of g.samples) {
      const gap = primaryGap(s);
      citations.push(sampleCitation(s, `${s.label}, ${s.date}: ${describeGapKind(gap.kind)}. ${gap.description}`));
      const decision = latestDecision.get(s.id);
      const cite = decision ? decisionCitation(decision.id, s) : null;
      if (cite) citations.push(cite);
    }
  }
  const runCite = runCitation(run, `Run ${runKey}: ${groups.size} ${groups.size === 1 ? "counterparty" : "counterparties"} with undefended samples.`);
  if (runCite) citations.push(runCite);
  const note =
    ranked.length === 0
      ? `No undefended samples in run ${runKey}${wanted ? ` for ${wanted}` : ""}: nothing is at stake there.`
      : undefined;
  return { rows, citations: dedupe(citations), resolvedRunId: runKey, ...(note ? { note } : {}) };
}

// ---------- 5. prior_rulings ----------

export async function priorRulings(args: ToolArgs): Promise<ToolResult> {
  const counterparty = str(args, "counterparty");
  const limit = limitArg(args, 10);
  if (!counterparty) {
    return { rows: [], citations: [], note: "Which counterparty? Name the vendor, bank counterparty, or Dodo type." };
  }

  // Exact equality first — the term memory applies — then, when the controller
  // typed "Stratus Compute" for the books' "Stratus Compute Inc.", a
  // case-insensitive containment.
  const exact = await db
    .select()
    .from(schema.learnedRules)
    .where(sql`lower(${schema.learnedRules.counterparty}) = ${counterparty.toLowerCase()}`)
    .orderBy(desc(schema.learnedRules.id))
    .limit(limit);
  const rules =
    exact.length > 0
      ? exact
      : await db
          .select()
          .from(schema.learnedRules)
          .where(sql`lower(${schema.learnedRules.counterparty}) like ${`%${counterparty.toLowerCase()}%`}`)
          .orderBy(desc(schema.learnedRules.id))
          .limit(limit);
  const matches = (name: string) =>
    exact.length > 0 ? sameCounterparty(name, counterparty) : name.toLowerCase().includes(counterparty.toLowerCase());

  // Every decision is read back, not just those behind a rule: a sufficient
  // verdict writes no learned_rules row but is still something the controller
  // decided here. The counterparty is derived through counterpartyFor(), the
  // same helper memory uses, so the two agree.
  const decisions = await db
    .select()
    .from(schema.refereeDecisions)
    .orderBy(desc(schema.refereeDecisions.id))
    .limit(300);
  const byRef = new Map<string, string>();
  const matchedDecisions: typeof decisions = [];
  for (const d of decisions) {
    if (!isSampleType(d.sampleType) || !isVerdict(d.decision)) continue;
    const key = formatSampleId({ type: d.sampleType, id: d.sampleId });
    let name = byRef.get(key);
    if (name === undefined) {
      try {
        name = await counterpartyFor({ type: d.sampleType, id: d.sampleId });
      } catch {
        name = "";
      }
      byRef.set(key, name);
    }
    if (name && matches(name)) matchedDecisions.push(d);
    if (matchedDecisions.length >= limit) break;
  }

  const rows: ToolRow[] = [];
  const citations: Citation[] = [];
  for (const r of rules) {
    const ref = isSampleType(r.sampleType) ? formatSampleId({ type: r.sampleType, id: r.sampleId }) : `${r.sampleType}:${r.sampleId}`;
    const usable = (MEMORY_VERDICTS as readonly string[]).includes(r.verdict) && /^\d+$/.test(r.runId) && Boolean(r.note);
    rows.push({
      source: `learned_rules#${r.id}`,
      verdict: r.verdict,
      gapKind: r.gapKind,
      note: r.note,
      remedy: r.remedy,
      run: r.runId,
      sample: ref,
      createdAt: r.createdAt.toISOString().slice(0, 10),
      usableByMemory: usable,
      href: sampleHref(r.runId, ref),
    });
    citations.push({
      table: "learned_rules",
      id: r.id,
      field: "note",
      value: r.note ?? "",
      reason: `The controller's ${r.verdict.replace(/_/g, " ")} on ${r.counterparty} in run ${r.runId}, filed against ${describeGapKind(r.gapKind)}.`,
    });
  }
  for (const d of matchedDecisions) {
    const ref = formatSampleId({ type: d.sampleType as SampleType, id: d.sampleId });
    rows.push({
      source: `referee_decisions#${d.id}`,
      verdict: d.decision,
      gapKind: null,
      note: d.note,
      remedy: d.remedy,
      run: d.runId,
      sample: ref,
      createdAt: d.createdAt.toISOString().slice(0, 10),
      usableByMemory: false,
      href: sampleHref(d.runId, ref),
    });
    citations.push({
      table: "referee_decisions",
      id: d.id,
      field: "decision",
      value: d.decision,
      reason: `Ruling on ${ref} in run ${d.runId}${d.note ? `: "${d.note}"` : "."}`,
    });
  }
  const note = rows.length === 0 ? `The controller has not ruled on ${counterparty} yet.` : undefined;
  return { rows, citations: dedupe(citations), ...(note ? { note } : {}) };
}

// ---------- 6. compare_runs ----------

type RunRow = typeof schema.auditRuns.$inferSelect;
type SampleRow = typeof schema.auditSamples.$inferSelect;

function runInputs(run: RunRow): string {
  return JSON.stringify([run.seed, run.materiality, run.sampleSize, [...(run.cycles ?? [])].sort()]);
}

function sideOf(run: RunRow, samples: SampleRow[]): ToolRow {
  const defended = samples.filter((s) => s.status === "defended").length;
  return {
    run: String(run.id),
    name: run.name,
    status: run.status,
    samples: samples.length,
    defended,
    resolvedByMemory: samples.filter((s) => s.resolution === MEMORY_RESOLUTION).length,
    gaps: samples.filter((s) => s.status === "gap" || s.status === "conceded").length,
    open: samples.filter((s) => s.status === "open").length,
    coveragePercent: samples.length === 0 ? 0 : Math.round((defended / samples.length) * 100),
    href: `/audit/${run.id}`,
  };
}

/**
 * With both ids omitted this is compareLatestRuns() from the engine, whose
 * comparability rule — same seed, materiality, sample size, and cycles — is
 * applied here too when the controller names the runs, and refused with a
 * note when it does not hold rather than inventing a trend from a change of
 * scope.
 */
export async function compareRuns(args: ToolArgs): Promise<ToolResult> {
  let latestId: number | undefined;
  let previousId: number | undefined;
  const latestArg = str(args, "runId");
  const previousArg = str(args, "previousRunId");

  if (latestArg && /^\d+$/.test(latestArg)) latestId = Number(latestArg);
  if (previousArg && /^\d+$/.test(previousArg)) previousId = Number(previousArg);

  const candidates = await db.select().from(schema.auditRuns).orderBy(desc(schema.auditRuns.id)).limit(24);
  if (candidates.length === 0) return { rows: [], citations: [], note: "There are no runs to compare." };
  const samplesAll = await db
    .select()
    .from(schema.auditSamples)
    .where(inArray(schema.auditSamples.runId, candidates.map((r) => r.id)))
    .orderBy(asc(schema.auditSamples.id));
  const byRun = new Map<number, SampleRow[]>();
  for (const s of samplesAll) {
    const list = byRun.get(s.runId);
    if (list) list.push(s);
    else byRun.set(s.runId, [s]);
  }
  const settled = (r: RunRow) => {
    const drawn = byRun.get(r.id) ?? [];
    return drawn.length > 0 && drawn.every((s) => s.status !== "open");
  };

  let latest = latestId === undefined ? candidates.find(settled) : candidates.find((r) => r.id === latestId);
  if (latestId !== undefined && !latest) {
    [latest] = await db.select().from(schema.auditRuns).where(eq(schema.auditRuns.id, latestId));
    if (latest) {
      byRun.set(
        latest.id,
        await db.select().from(schema.auditSamples).where(eq(schema.auditSamples.runId, latest.id)),
      );
    }
  }
  if (!latest) return { rows: [], citations: [], note: "No finished run to compare yet." };

  let previous: RunRow | undefined;
  if (previousId !== undefined) {
    previous = candidates.find((r) => r.id === previousId);
    if (!previous) {
      [previous] = await db.select().from(schema.auditRuns).where(eq(schema.auditRuns.id, previousId));
      if (previous) {
        byRun.set(
          previous.id,
          await db.select().from(schema.auditSamples).where(eq(schema.auditSamples.runId, previous.id)),
        );
      }
    }
    if (!previous) return { rows: [], citations: [], note: `There is no run ${previousId}.`, resolvedRunId: String(latest.id) };
  } else {
    const l = latest;
    previous = candidates.find((r) => r.id < l.id && settled(r) && runInputs(r) === runInputs(l));
    if (!previous) {
      return {
        rows: [sideOf(latest, byRun.get(latest.id) ?? [])],
        citations: [
          { table: "audit_runs", id: latest.id, field: "name", value: latest.name, reason: "The latest finished run." },
        ],
        note: `No earlier run used the same seed, materiality, sample size, and cycles as run ${latest.id}, so there is nothing it can honestly be compared to.`,
        resolvedRunId: String(latest.id),
      };
    }
  }

  const rows: ToolRow[] = [];
  const citations: Citation[] = [];
  const latestSide = sideOf(latest, byRun.get(latest.id) ?? []);
  const previousSide = sideOf(previous, byRun.get(previous.id) ?? []);
  if (runInputs(previous) !== runInputs(latest)) {
    return {
      rows: [
        { side: "previous", ...previousSide },
        { side: "latest", ...latestSide },
      ],
      citations: [
        { table: "audit_runs", id: previous.id, field: "name", value: previous.name, reason: "The earlier run." },
        { table: "audit_runs", id: latest.id, field: "name", value: latest.name, reason: "The later run." },
      ],
      note: `Runs ${previous.id} and ${latest.id} drew their samples with different inputs (seed, materiality, sample size, or cycles), so their coverage figures are not comparable.`,
      resolvedRunId: String(latest.id),
    };
  }

  rows.push({ side: "previous", ...previousSide }, { side: "latest", ...latestSide });
  citations.push(
    {
      table: "audit_runs",
      id: previous.id,
      field: "name",
      value: previous.name,
      reason: `Run ${previous.id}: ${previousSide.defended} of ${previousSide.samples} defended (${previousSide.coveragePercent}%).`,
    },
    {
      table: "audit_runs",
      id: latest.id,
      field: "name",
      value: latest.name,
      reason: `Run ${latest.id}: ${latestSide.defended} of ${latestSide.samples} defended (${latestSide.coveragePercent}%), ${latestSide.resolvedByMemory} resolved by memory.`,
    },
  );

  // Items sampled by both runs that the earlier run did not close cleanly.
  const before = new Map(
    (byRun.get(previous.id) ?? []).map((s) => [formatSampleId({ type: s.sampleType as SampleType, id: s.sampleId }), s]),
  );
  const recurring: { id: string; s: SampleRow; earlier: SampleRow }[] = [];
  for (const s of byRun.get(latest.id) ?? []) {
    const id = formatSampleId({ type: s.sampleType as SampleType, id: s.sampleId });
    const earlier = before.get(id);
    if (!earlier || earlier.status === "defended") continue;
    recurring.push({ id, s, earlier });
  }
  recurring.sort((a, b) => {
    const am = a.s.resolution === MEMORY_RESOLUTION;
    const bm = b.s.resolution === MEMORY_RESOLUTION;
    if (am !== bm) return am ? -1 : 1;
    return a.s.sampleId - b.s.sampleId;
  });
  for (const item of recurring.slice(0, 6)) {
    const type = item.s.sampleType as SampleType;
    const counterparty = await counterpartyFor({ type, id: item.s.sampleId });
    rows.push({
      side: "recurring",
      sample: item.id,
      counterparty,
      amount: formatMoney(item.s.amount),
      before: item.earlier.status,
      after: item.s.status,
      resolvedByMemory: item.s.resolution === MEMORY_RESOLUTION,
      href: sampleHref(String(latest.id), item.id),
    });
    citations.push({
      table: sampleTable(type),
      id: item.s.sampleId,
      field: "amount",
      value: formatMoney(item.s.amount),
      reason: `${counterparty}: ${item.earlier.status} in run ${previous.id}, ${item.s.status} in run ${latest.id}${item.s.resolution === MEMORY_RESOLUTION ? " (resolved by memory)" : ""}.`,
    });
  }
  const note = recurring.length > 6 ? `${recurring.length} recurring items; showing 6.` : undefined;
  return { rows, citations: dedupe(citations), resolvedRunId: String(latest.id), ...(note ? { note } : {}) };
}

// ---------- 7. where_is ----------

export async function whereIs(args: ToolArgs): Promise<ToolResult> {
  const query = (str(args, "query") ?? "").replace(/[?.!]+$/, "").trim();
  const runKey = await resolveRunArg(args.runId);
  if (!query) return { rows: [], citations: [], note: "What should I find? A sample like invoice:24, a run name, or the binder.", resolvedRunId: runKey };

  const run = await getRun(runKey);
  const lower = query.toLowerCase();
  const found = (label: string, href: string, kind: string, citation: Citation): ToolResult => ({
    rows: [{ label, href, kind }],
    citations: [citation],
    resolvedRunId: runKey,
  });

  if (/\bbinder\b/.test(lower) && run) {
    const cite = runCitation(run, "The run whose binder this is.") ?? sampleCitation(run.samples[0]);
    return found(`Binder for run ${runKey}`, `/audit/${encodeURIComponent(runKey)}/binder`, "binder", cite);
  }

  const explicit = parseSampleId(lower.match(/(?:invoice|bank|dodo):\d+/)?.[0] ?? "");
  if (explicit && run) {
    const id = formatSampleId(explicit);
    const sample = run.samples.find((s) => s.id === id);
    if (sample) return found(sample.label, sampleHref(runKey, id), "sample", sampleCitation(sample));
    return { rows: [], citations: [], note: `Sample ${id} is not part of run ${runKey}.`, resolvedRunId: runKey };
  }

  if (/^\d+$/.test(lower)) {
    const n = Number(lower);
    const matches = run?.samples.filter((s) => sampleIdOf(s) === n) ?? [];
    if (matches.length === 1) {
      const sample = matches[0];
      return found(sample.label, sampleHref(runKey, sample.id), "sample", sampleCitation(sample));
    }
    const runs = await recentRuns(100);
    const hit = runs.find((r) => r.id === n);
    if (hit) {
      return found(hit.name, `/audit/${hit.id}`, "run", {
        table: "audit_runs",
        id: hit.id,
        field: "name",
        value: hit.name,
        reason: `Run ${hit.id}.`,
      });
    }
  }

  const runNumber = lower.match(/\brun\s*#?(\d+)\b/);
  if (runNumber) {
    const runs = await recentRuns(100);
    const hit = runs.find((r) => r.id === Number(runNumber[1]));
    if (hit) {
      return found(hit.name, `/audit/${hit.id}`, "run", {
        table: "audit_runs",
        id: hit.id,
        field: "name",
        value: hit.name,
        reason: `Run ${hit.id}.`,
      });
    }
  }

  if (run) {
    const byLabel = run.samples.filter((s) => s.label.toLowerCase().includes(lower));
    if (byLabel.length === 1) {
      const sample = byLabel[0];
      return found(sample.label, sampleHref(runKey, sample.id), "sample", sampleCitation(sample));
    }
    if (byLabel.length > 1) {
      return {
        rows: byLabel.slice(0, 8).map((s) => ({ label: s.label, href: sampleHref(runKey, s.id), kind: "sample" })),
        citations: byLabel.slice(0, 8).map((s) => sampleCitation(s)),
        note: `${byLabel.length} samples in run ${runKey} match "${query}".`,
        resolvedRunId: runKey,
      };
    }
  }

  const runs = await recentRuns(100);
  const byName = runs.filter((r) => r.name.toLowerCase().includes(lower));
  if (byName.length === 1) {
    const hit = byName[0];
    return found(hit.name, `/audit/${hit.id}`, "run", {
      table: "audit_runs",
      id: hit.id,
      field: "name",
      value: hit.name,
      reason: `Run ${hit.id}.`,
    });
  }
  return { rows: [], citations: [], note: `Nothing matched "${query}" uniquely.`, resolvedRunId: runKey };
}

// ---------- 8. draft_note ----------

const NOTE_MAX = 500;

/** The deterministic sentence, assembled from the gap and the sampled row. */
export function buildFallbackNote(ctx: SampleContext, verdict: DraftVerdict): string {
  const { sample } = ctx;
  const gap = primaryGap(sample);
  const cite = `[${sampleTable(sample.type)}#${sampleIdOf(sample)}]`;
  const amount = formatMoney(sample.amount);
  const what = gap.description ? gap.description.replace(/\s+$/, "").replace(/\.$/, "") : `the accountant found no gap`;
  let text: string;
  switch (verdict) {
    case "needs_more":
      text = `Search again on ${sample.label} (${amount}, ${sample.date}) ${cite}: ${what}; check the source documents and the ledger for that month and cite what turns up.`;
      break;
    case "accepted_with_note":
      text = `Accepted: ${sample.label} for ${amount} on ${sample.date} ${cite} is ${describeGapKind(gap.kind)} (${what}), recorded here and not pursued further.`;
      break;
    case "exception":
      text = `Finding on ${sample.label}, ${amount}, ${sample.date} ${cite}: ${describeGapKind(gap.kind)}; ${what}. Proposed entry: Dr ${ctx.entry.debit} / Cr ${ctx.entry.credit} ${ctx.entry.amount}.`;
      break;
  }
  return normaliseNote(text) ?? text.slice(0, NOTE_MAX);
}

function draftPrompt(ctx: SampleContext, verdict: DraftVerdict): string {
  const { sample, entry } = ctx;
  const evidence = latestEvidence(sample);
  const gap = primaryGap(sample);
  const citations = (evidence?.citations ?? [])
    .map((c, i) => `${i + 1}. [${c.table}#${c.id}] ${c.field} = ${c.value} — ${c.reason}`)
    .join("\n");
  const ask: Record<DraftVerdict, string> = {
    needs_more: "a needs-more note telling the accountant where to look next",
    accepted_with_note: "an accept-with-note saying what is being accepted and why it is not worth pursuing",
    exception: "an exception note stating the finding and its amount",
  };
  return [
    `Sample: ${sample.id} — ${sample.label}, ${formatMoney(sample.amount)}, ${sample.date} [${sampleTable(sample.type)}#${sampleIdOf(sample)}]`,
    `Gap: ${gap.kind}: ${gap.description || "(none)"}`,
    `Proposed entry: Dr ${entry.debit} / Cr ${entry.credit} ${entry.amount} (${entry.amountSource})`,
    "",
    "Evidence on file:",
    citations || "(none)",
    "",
    `Write ${ask[verdict]}. One or two sentences, under 400 characters, citing the rows in square brackets.`,
  ].join("\n");
}

export async function draftNote(args: ToolArgs): Promise<ToolResult> {
  const verdictArg = (str(args, "verdict") ?? "").toLowerCase().replace(/[\s-]+/g, "_").replace(/^accept_with_note$/, "accepted_with_note");
  if (!isDraftVerdict(verdictArg)) {
    return {
      rows: [],
      citations: [],
      note: `A note can be drafted for needs_more, accepted_with_note, or exception, not "${verdictArg || "(none)"}".`,
    };
  }
  const ctx = await loadSampleContext(args);
  if ("error" in ctx) return ctx.error;
  const verdict: DraftVerdict = verdictArg;

  const bundleCitations = dedupe([sampleCitation(ctx.sample), ...(latestEvidence(ctx.sample)?.citations ?? [])]);
  const explained = await explainSample(args);
  let text: string;
  let source: "model" | "fallback";
  let reason: string | undefined;

  if (llmDisabled()) {
    text = buildFallbackNote(ctx, verdict);
    source = "fallback";
    reason = "the model was turned off (CROSSFIRE_NO_LLM)";
  } else {
    const prompt = draftPrompt(ctx, verdict);
    try {
      if (llmForcedToFail()) throw new Error("[draft probe] simulated model failure (CROSSFIRE_LLM_FAIL)");
      const modelText = await traceLlmCall(
        { name: "assistant.draft_note", model: LLM_MODEL, input: prompt, metadata: { sample: ctx.sample.id, verdict } },
        () => complete(DRAFT_SYSTEM_PROMPT, prompt),
      );
      // The same two checks every answer passes: every factual sentence cites
      // a row on file, and every number came from those rows.
      const final = finalizeAnswer(modelText.replace(/\s+/g, " ").trim(), [
        { name: "explain_sample", args: { sampleRef: ctx.sample.id, runId: ctx.runKey }, ...explained },
      ]);
      if (final.source === "model" && final.content.length <= NOTE_MAX) {
        text = final.content;
        source = "model";
      } else {
        text = buildFallbackNote(ctx, verdict);
        source = "fallback";
        reason = final.source === "fallback" ? final.reason : `the draft ran to ${final.content.length} characters`;
      }
    } catch (err) {
      text = buildFallbackNote(ctx, verdict);
      source = "fallback";
      reason = `the model call failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const draft: RulingDraft = {
    kind: "note",
    verdict,
    text,
    citations: bundleCitations,
    runId: ctx.runKey,
    sampleRef: ctx.sample.id,
    source,
    ...(verdict === "exception" ? { remedy: remedyFor(primaryGap(ctx.sample).kind), entry: ctx.entry } : {}),
  };
  const rows: ToolRow[] = [
    {
      sample: ctx.sample.id,
      verdict,
      draft: text,
      source,
      ...(draft.remedy ? { remedy: REMEDY_LABEL[draft.remedy] } : {}),
      href: sampleHref(ctx.runKey, ctx.sample.id),
    },
  ];
  return {
    rows,
    citations: bundleCitations,
    resolvedRunId: ctx.runKey,
    draft,
    note: `Drafted for ${VERDICT_LABEL[verdict].toLowerCase()}; nothing is filed until you click.${reason ? ` Assembled from the rows (${reason}).` : ""}`,
  };
}

// ---------- 9. propose_remedy ----------

export async function proposeRemedy(args: ToolArgs): Promise<ToolResult> {
  const ctx = await loadSampleContext(args);
  if ("error" in ctx) return ctx.error;
  const gap = primaryGap(ctx.sample);
  const remedy = remedyFor(gap.kind);
  const citations = dedupe([sampleCitation(ctx.sample), ...ctx.entry.basis]);
  const draft: RulingDraft = {
    kind: "remedy",
    verdict: "exception",
    text: "",
    remedy,
    entry: ctx.entry,
    citations,
    runId: ctx.runKey,
    sampleRef: ctx.sample.id,
    source: "fallback",
  };
  return {
    rows: [
      {
        sample: ctx.sample.id,
        gapKind: gap.kind,
        remedy: REMEDY_LABEL[remedy],
        debit: ctx.entry.debit,
        credit: ctx.entry.credit,
        amount: ctx.entry.amount,
        amountSource: ctx.entry.amountSource,
        memo: ctx.entry.memo,
        href: sampleHref(ctx.runKey, ctx.sample.id),
      },
    ],
    citations,
    resolvedRunId: ctx.runKey,
    draft,
    note: "A pre-selection only; choosing the remedy and clicking files the exception.",
  };
}

// ---------- 10. start_run (proposal) ----------

/**
 * What the model may do about a run: propose it. The parameters are normalized
 * exactly as the home page form's would be and handed back for a human to
 * confirm; ./start-run.ts is what runs them, and only from a click.
 */
export function startRunProposal(args: ToolArgs): ToolResult {
  const dollars = int(args, "materiality");
  const cyclesArg = args.cycles;
  const cycles = Array.isArray(cyclesArg)
    ? cyclesArg.map(String)
    : typeof cyclesArg === "string"
      ? cyclesArg.split(/[,\s]+/).filter(Boolean)
      : undefined;
  const normalized = normalizeRunInput({
    name: str(args, "name"),
    seed: int(args, "seed"),
    materiality: dollars === undefined ? undefined : dollars * 100,
    sampleSize: int(args, "sampleSize") ?? int(args, "samples"),
    cycles: cycles ? parseCycles(cycles) : undefined,
  });
  const draft: StartRunDraft = {
    kind: "start_run",
    params: {
      name: normalized.name,
      seed: normalized.seed,
      materiality: normalized.materiality,
      sampleSize: normalized.sampleSize,
      cycles: normalized.cycles,
    },
  };
  return {
    rows: [
      {
        name: normalized.name,
        seed: normalized.seed,
        materiality: formatMoney(normalized.materiality / 100),
        sampleSize: normalized.sampleSize,
        cycles: normalized.cycles.join(", "),
        status: "awaiting your confirmation",
      },
    ],
    citations: [],
    note: "Nothing has started. Confirm the parameters with the Start run button.",
    draft,
  };
}

export type { SampleContext, Verdict };

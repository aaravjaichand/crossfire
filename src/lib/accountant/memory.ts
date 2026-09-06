/**
 * Run memory: what the controller has already ruled, read back before the
 * accountant defends the same kind of item again.
 *
 * Every ruling that carries judgement is filed in learned_rules by the referee
 * (src/lib/referee/decide.ts) under the counterparty and the gap kind it was
 * made against. This module is the other half of that loop — the read side —
 * and it is deliberately plain code: matching is two string comparisons, never
 * a model call, so a rule either matches or it does not and the same books
 * plus the same rulings always produce the same run.
 *
 * Two rules are honoured, and only these two:
 *
 *   accepted_with_note  The controller looked at this exact situation and
 *                       decided to live with it. Asking the accountant to
 *                       search again cannot change that answer, so the sample
 *                       settles as defended with `resolution = "memory"` and a
 *                       turn that quotes the ruling and cites it.
 *   needs_more          The controller said where to look. The note is added
 *                       to the accountant's search context on the next run, so
 *                       the second pass answers what the first one missed.
 *
 * An `exception` rule is not used here on purpose: it records a finding, and
 * carrying it forward would let a run mark its own findings resolved. A
 * `sufficient` verdict writes no rule at all.
 *
 * Three narrowing rules keep memory honest:
 *
 *   - Rules filed by the run being worked are excluded, or a run would teach
 *     itself.
 *   - Only rules filed under a numeric run key are read. The walkthrough run
 *     files under "mock", and a ruling made on a fixture must never settle a
 *     sample drawn from the real books.
 *   - The counterparty is derived through loadSampleDetail(), the same row
 *     facts the referee's label is built from, so the string written by a
 *     ruling and the string looked up here cannot drift apart.
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { TABLE_BY_SAMPLE_TYPE } from "@/lib/auditor/citation";
import { loadSampleDetail } from "@/lib/auditor/detail";
import type { Citation, EvidenceBundle, GapKind, SampleRef, SampleType } from "./types";

/** audit_samples.resolution for a sample settled by a remembered ruling. */
export const MEMORY_RESOLUTION = "memory";

/** The verdicts that teach the accountant something it can act on. */
export const MEMORY_VERDICTS = ["accepted_with_note", "needs_more"] as const;
export type MemoryVerdict = (typeof MEMORY_VERDICTS)[number];

/** Search notes carried into one defense. More than this is noise, not memory. */
export const MAX_SEARCH_NOTES = 3;

export type LearnedRule = {
  id: number;
  runId: string;
  sampleType: SampleType;
  sampleId: number;
  gapKind: string;
  counterparty: string;
  note: string;
  remedy: string | null;
  verdict: MemoryVerdict;
};

export type SampleMemory = {
  /** Vendor name, bank counterparty, or Dodo type — the key rules are filed under. */
  counterparty: string;
  /** Every usable rule for this counterparty from an earlier run, oldest first. */
  rules: LearnedRule[];
};

export const EMPTY_MEMORY: SampleMemory = { counterparty: "", rules: [] };

/**
 * The counterparty a rule about this sample is filed under. Must agree
 * character for character with counterpartyOf() in src/lib/referee/data.ts,
 * which reads it off the sample's label: the vendor name for an invoice, the
 * bank counterparty for a payment, and the bare type for a Dodo row.
 */
export async function counterpartyFor(ref: SampleRef): Promise<string> {
  const detail = await loadSampleDetail({
    sampleType: ref.type,
    sampleId: ref.id,
    // loadSampleDetail reads the row by type and id; the rest of the candidate
    // is unused by it and is filled only to satisfy the type.
    amountCents: 0,
    date: "",
    cycle: "purchases",
    riskScore: 0,
    riskReasons: [],
  });
  if (detail.kind === "invoice") return detail.vendorName;
  if (detail.kind === "bank_transaction") return detail.counterparty;
  return detail.type;
}

/**
 * Everything the controller has ruled about this counterparty in an earlier
 * run. Read once per sample, before any evidence is gathered, so the notes are
 * available to the first defense and the accepted rulings are available the
 * moment the gap kind is known.
 */
export async function loadSampleMemory(
  ref: SampleRef,
  options: { runId: number },
): Promise<SampleMemory> {
  const counterparty = await counterpartyFor(ref);
  if (!counterparty) return EMPTY_MEMORY;

  const rows = await db
    .select()
    .from(schema.learnedRules)
    .where(
      and(
        eq(schema.learnedRules.counterparty, counterparty),
        inArray(schema.learnedRules.verdict, [...MEMORY_VERDICTS]),
        // Numeric run keys only: "mock" and anything else synthetic is a
        // fixture, and a fixture must not settle a real sample.
        sql`${schema.learnedRules.runId} ~ '^[0-9]+$'`,
        ne(schema.learnedRules.runId, String(options.runId)),
      ),
    )
    .orderBy(asc(schema.learnedRules.id));

  const rules: LearnedRule[] = [];
  for (const row of rows) {
    const note = row.note?.trim() ?? "";
    // A rule with no note has nothing to tell the accountant: needs_more and
    // accepted_with_note are both refused without one, so this only ever skips
    // a row written before that was enforced.
    if (!note) continue;
    if (!isSampleType(row.sampleType) || !isMemoryVerdict(row.verdict)) continue;
    rules.push({
      id: row.id,
      runId: row.runId,
      sampleType: row.sampleType,
      sampleId: row.sampleId,
      gapKind: row.gapKind,
      counterparty: row.counterparty,
      note,
      remedy: row.remedy,
      verdict: row.verdict,
    });
  }
  return { counterparty, rules };
}

/**
 * The accepted ruling that settles this sample, or null. Matched on the
 * counterparty (already applied by the query) and the gap kind the accountant
 * just admitted, which is the pair the controller's judgement was about: same
 * counterparty, same kind of gap, same answer. A rule filed on this very row
 * wins over a rule filed on a sibling row, and the newest rule wins over an
 * older one, so a controller who changes their mind is obeyed.
 */
export function acceptedRuleFor(memory: SampleMemory, ref: SampleRef, gapKind: string): LearnedRule | null {
  const matches = memory.rules.filter(
    (rule) => rule.verdict === "accepted_with_note" && rule.gapKind === gapKind,
  );
  if (matches.length === 0) return null;
  const exact = matches.filter((r) => r.sampleType === ref.type && r.sampleId === ref.id);
  const pool = exact.length > 0 ? exact : matches;
  return pool[pool.length - 1];
}

/**
 * The controller's "look here" notes, phrased as the accountant reading its
 * own file. They travel in the accountant's search context (DefendOptions.
 * followUps), which is prose the model must answer — it never widens what may
 * be cited, so a note cannot conjure a row that is not in the books.
 */
export function memorySearchNotes(memory: SampleMemory): string[] {
  return memory.rules
    .filter((rule) => rule.verdict === "needs_more")
    .slice(-MAX_SEARCH_NOTES)
    .map(
      (rule) =>
        `From run memory, the controller's note on ${rule.counterparty} (run ${rule.runId}, ${describeGapKind(rule.gapKind)}): "${rule.note}" Search there first and cite what you find.`,
    );
}

/** The rules a defense was written with, as citations on its bundle. */
export function consultedRules(memory: SampleMemory): LearnedRule[] {
  return memory.rules.filter((rule) => rule.verdict === "needs_more").slice(-MAX_SEARCH_NOTES);
}

/**
 * A learned rule as an evidence row. learned_rules is a table with row ids like
 * any other, so a claim that rests on a controller's ruling cites it the same
 * way a claim about an amount cites the invoice.
 */
export function ruleCitation(rule: LearnedRule): Citation {
  return {
    table: "learned_rules",
    id: rule.id,
    field: "note",
    value: rule.note,
    reason: `The controller's ${rule.verdict === "needs_more" ? "needs-more" : "accept-with-note"} ruling on ${rule.counterparty} in run ${rule.runId}, filed against ${describeGapKind(rule.gapKind)}.`,
  };
}

/** The row the ruling was originally made on, as a citation. */
export function ruleSampleCitation(rule: LearnedRule): Citation {
  return {
    table: TABLE_BY_SAMPLE_TYPE[rule.sampleType],
    id: rule.sampleId,
    field: "id",
    value: String(rule.sampleId),
    reason: `The item the controller ruled on in run ${rule.runId}.`,
  };
}

export type MemoryTurn = { content: string; evidence: EvidenceBundle };

/**
 * The accountant's turn when memory settles a sample: it quotes the ruling,
 * names the run it came from, and cites the rule, the row it was made on, and
 * the row under audit. Written here rather than by the model — there is
 * nothing to phrase, only a ruling to repeat accurately.
 *
 * The bundle carries no gaps: the gap is still on the record on the previous
 * accountant turn, and this turn's claim is that the controller has already
 * disposed of it.
 */
export function buildMemoryTurn(ref: SampleRef, rule: LearnedRule, gapKind: string): MemoryTurn {
  const here = sampleCitationRow(ref);
  const citations: Citation[] = [ruleCitation(rule), here];
  const sameRow = rule.sampleType === ref.type && rule.sampleId === ref.id;
  if (!sameRow) citations.splice(1, 0, ruleSampleCitation(rule));

  const origin = sameRow
    ? `on this same item in run ${rule.runId}`
    : `on ${TABLE_BY_SAMPLE_TYPE[rule.sampleType]}#${rule.sampleId} in run ${rule.runId}`;

  const content = [
    `The controller has already ruled on ${describeGapKind(gapKind)} for ${rule.counterparty}, ${origin}, and accepted it with a note [learned_rules#${rule.id}].`,
    `Their words: "${rule.note}" [learned_rules#${rule.id}].`,
    `That ruling covers this item [${here.table}#${here.id}], so it is carried forward rather than raised again.`,
  ].join(" ");

  return {
    content,
    evidence: {
      sample: ref,
      citations,
      gaps: [],
      defense: content,
      defenseSource: {
        source: "fallback",
        reason: "carried forward from the controller's earlier ruling",
      },
    },
  };
}

/**
 * The samples of a run that were settled by memory, as "invoice:5" ids, for
 * the run screen. Reads the persisted column rather than the thread, so the
 * screen and the binder agree without either of them guessing.
 */
export async function memoryResolvedIds(runKey: string): Promise<Set<string>> {
  if (!/^\d+$/.test(runKey)) return new Set();
  const rows = await db
    .select({
      sampleType: schema.auditSamples.sampleType,
      sampleId: schema.auditSamples.sampleId,
    })
    .from(schema.auditSamples)
    .where(
      and(
        eq(schema.auditSamples.runId, Number(runKey)),
        eq(schema.auditSamples.resolution, MEMORY_RESOLUTION),
      ),
    );
  return new Set(rows.map((r) => `${r.sampleType}:${r.sampleId}`));
}

// ---------- internals ----------

const SAMPLE_TYPES: SampleType[] = ["bank_transaction", "invoice", "dodo_transaction"];

function isSampleType(value: string): value is SampleType {
  return (SAMPLE_TYPES as string[]).includes(value);
}

function isMemoryVerdict(value: string): value is MemoryVerdict {
  return (MEMORY_VERDICTS as readonly string[]).includes(value);
}

function sampleCitationRow(ref: SampleRef): Citation {
  return {
    table: TABLE_BY_SAMPLE_TYPE[ref.type],
    id: ref.id,
    field: "id",
    value: String(ref.id),
    reason: "The item under audit here.",
  };
}

/** "a rate mismatch" from "rate_mismatch", for prose. */
export function describeGapKind(kind: string): string {
  const words = kind.replace(/_/g, " ");
  return kind === "other" ? "an unclassified gap" : `a ${words}`;
}

export type { GapKind };

/**
 * Records on the bundle which rules the defense was written with. The rows are
 * added after the search, so they never widen what the accountant may claim —
 * they are provenance: this answer was written with the controller's earlier
 * note in hand, and here is the note's row id.
 */
export function withConsultedRules(bundle: EvidenceBundle, rules: LearnedRule[]): EvidenceBundle {
  if (rules.length === 0) return bundle;
  const seen = new Set(bundle.citations.map((c) => `${c.table}#${c.id}`));
  const added = rules
    .map(ruleCitation)
    .filter((c) => !seen.has(`${c.table}#${c.id}`));
  if (added.length === 0) return bundle;
  return { ...bundle, citations: [...bundle.citations, ...added] };
}

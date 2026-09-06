/**
 * Run against run: what changed between the last two audits of the same books.
 *
 * The point of the product is that the second run is better than the first
 * because a person ruled on the first, so the comparison is a first-class read
 * model rather than something a reader has to reconstruct from two rows of a
 * table. It is plain SQL over audit_samples: no model, no heuristics, and the
 * "resolved by memory" count is the persisted resolution column rather than an
 * inference from the transcript.
 */
import { asc, desc, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { counterpartyFor, MEMORY_RESOLUTION } from "@/lib/accountant/memory";
import type { SampleType } from "@/lib/accountant/types";
import { formatSampleId } from "@/lib/referee/sample-id";

export type RunSide = {
  id: number;
  name: string;
  createdAt: Date;
  status: string;
  total: number;
  /** Includes the samples memory settled: they are defended. */
  defended: number;
  resolvedByMemory: number;
  gaps: number;
  open: number;
  /** defended / total, as a whole percent. */
  coverage: number;
};

export type RecurringItem = {
  /** "invoice:5" — the same id the run screen uses in its URLs. */
  id: string;
  type: SampleType;
  sampleId: number;
  /** Vendor name, bank counterparty, or Dodo type. */
  counterparty: string;
  amount: string;
  /** open | defended | gap | conceded, in each run. */
  before: string;
  after: string;
  resolvedByMemory: boolean;
};

export type RunComparison = {
  previous: RunSide;
  latest: RunSide;
  /** Items sampled by both runs that the earlier run did not close cleanly. */
  recurring: RecurringItem[];
  /** How many of those there are in total, when the list above is truncated. */
  recurringTotal: number;
};

/** Recurring items shown before the panel starts summarising the rest. */
export const MAX_RECURRING = 6;

/** How far back to look for a run the latest one can honestly be compared to. */
const LOOKBACK = 24;

type SampleRow = typeof schema.auditSamples.$inferSelect;
type RunRow = typeof schema.auditRuns.$inferSelect;

/**
 * The inputs a run drew its sample from. Two runs are comparable when these
 * agree: coverage over six purchases samples at $21,000 materiality is not the
 * same measurement as coverage over twenty-five samples across four cycles, and
 * putting the two percentages side by side under "since the last run" would
 * invent a trend out of a change of scope.
 */
function inputs(run: RunRow): string {
  return JSON.stringify([run.seed, run.materiality, run.sampleSize, [...(run.cycles ?? [])].sort()]);
}

/**
 * The two most recent comparable runs, older first, or null when there is no
 * such pair to show.
 *
 * A run qualifies only once it has settled every sample it drew. A run still in
 * flight has no coverage number yet, and one whose samples were all left open —
 * what a probe that persists rows without working them looks like — would read
 * as 0% and slander the run before it.
 */
export async function compareLatestRuns(): Promise<RunComparison | null> {
  const runs = await db
    .select()
    .from(schema.auditRuns)
    .orderBy(desc(schema.auditRuns.id))
    .limit(LOOKBACK);
  if (runs.length < 2) return null;

  const samples = await db
    .select()
    .from(schema.auditSamples)
    .where(
      inArray(
        schema.auditSamples.runId,
        runs.map((r) => r.id),
      ),
    )
    .orderBy(asc(schema.auditSamples.id));

  const byRun = new Map<number, SampleRow[]>();
  for (const sample of samples) {
    const list = byRun.get(sample.runId);
    if (list) list.push(sample);
    else byRun.set(sample.runId, [sample]);
  }

  const settled = runs.filter((r) => {
    const drawn = byRun.get(r.id) ?? [];
    return drawn.length > 0 && drawn.every((s) => s.status !== "open");
  });
  if (settled.length < 2) return null;

  // Newest first, so the first match walking forward is the most recent run the
  // latest one can be held against.
  const [latestRun] = settled;
  const previousRun = settled.slice(1).find((r) => inputs(r) === inputs(latestRun));
  if (!previousRun) return null;

  const latest = side(latestRun, byRun.get(latestRun.id) ?? []);
  const previous = side(previousRun, byRun.get(previousRun.id) ?? []);

  const recurring = await recurringItems(
    byRun.get(previousRun.id) ?? [],
    byRun.get(latestRun.id) ?? [],
  );
  return { previous, latest, ...recurring };
}

function side(run: typeof schema.auditRuns.$inferSelect, samples: SampleRow[]): RunSide {
  const defended = samples.filter((s) => s.status === "defended").length;
  return {
    id: run.id,
    name: run.name,
    createdAt: run.createdAt,
    status: run.status,
    total: samples.length,
    defended,
    resolvedByMemory: samples.filter((s) => s.resolution === MEMORY_RESOLUTION).length,
    gaps: samples.filter((s) => s.status === "gap" || s.status === "conceded").length,
    open: samples.filter((s) => s.status === "open").length,
    coverage: samples.length === 0 ? 0 : Math.round((defended / samples.length) * 100),
  };
}

/**
 * The items worth looking at twice: sampled by both runs, and left unclosed by
 * the earlier one. A sample the first run defended on its own evidence and the
 * second run defended again has nothing to say about learning, so it is not
 * listed; a gap that came back, or a gap the controller's ruling closed, is
 * exactly the story.
 */
async function recurringItems(
  previous: SampleRow[],
  latest: SampleRow[],
): Promise<{ recurring: RecurringItem[]; recurringTotal: number }> {
  // formatSampleId, not the raw column: `id` is handed to the run screen as
  // ?s=, which matches it against SampleView.id ("bank:109").
  const key = (s: SampleRow) => formatSampleId({ type: s.sampleType as SampleType, id: s.sampleId });
  const before = new Map(previous.map((s) => [key(s), s]));
  const items: RecurringItem[] = [];

  for (const sample of latest) {
    const id = key(sample);
    const earlier = before.get(id);
    if (!earlier || earlier.status === "defended") continue;
    items.push({
      id,
      type: sample.sampleType as SampleType,
      sampleId: sample.sampleId,
      counterparty: "",
      amount: sample.amount,
      before: earlier.status,
      after: sample.status,
      resolvedByMemory: sample.resolution === MEMORY_RESOLUTION,
    });
  }

  // Resolved first: the panel is about what memory did, and a reader should not
  // have to hunt for it. Stable within each group by sample id.
  items.sort((a, b) => {
    if (a.resolvedByMemory !== b.resolvedByMemory) return a.resolvedByMemory ? -1 : 1;
    return a.sampleId - b.sampleId;
  });

  // One row read per item shown, and never more than MAX_RECURRING of them.
  const shown = items.slice(0, MAX_RECURRING);
  for (const item of shown) {
    item.counterparty = await counterpartyFor({ type: item.type, id: item.sampleId });
  }
  return { recurring: shown, recurringTotal: items.length };
}

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

type SampleRow = typeof schema.auditSamples.$inferSelect;

/**
 * The two most recent runs, older first, or null when there is only one run to
 * look at. Runs with no samples are skipped: a run that never drew a sample has
 * no coverage to compare.
 */
export async function compareLatestRuns(): Promise<RunComparison | null> {
  const runs = await db
    .select()
    .from(schema.auditRuns)
    .orderBy(desc(schema.auditRuns.id))
    .limit(8);
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

  const withSamples = runs.filter((r) => (byRun.get(r.id)?.length ?? 0) > 0);
  if (withSamples.length < 2) return null;

  const [latestRun, previousRun] = withSamples;
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
  const before = new Map(previous.map((s) => [`${s.sampleType}:${s.sampleId}`, s]));
  const items: RecurringItem[] = [];

  for (const sample of latest) {
    const id = `${sample.sampleType}:${sample.sampleId}`;
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

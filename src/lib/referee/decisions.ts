import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { SampleRef } from "./evidence-types";
import { formatSampleId, isSampleType } from "./sample-id";

export type DecisionKind = "approve" | "redirect" | "concede";

export type StoredDecision = {
  decision: DecisionKind;
  note: string | null;
  at: Date;
};

// Status overrides live in memory, keyed by run id then sample id, so the mock
// run reflects referee actions without adding columns to Worker B's tables.
// The map is a write-through cache of referee_decisions: it is filled from the
// table the first time a run is read, then appended to on every action, so a
// server restart does not lose decisions that are already persisted.
type RunOverrides = Map<string, StoredDecision[]>;

const globalForReferee = globalThis as unknown as {
  __crossfireRefereeOverrides?: Map<string, RunOverrides>;
  __crossfireRefereeHydration?: Map<string, Promise<void>>;
};

const overrides = (globalForReferee.__crossfireRefereeOverrides ??= new Map());
const hydration = (globalForReferee.__crossfireRefereeHydration ??= new Map());

export async function ensureHydrated(runId: string): Promise<RunOverrides> {
  let pending = hydration.get(runId);
  if (!pending) {
    pending = hydrate(runId);
    hydration.set(runId, pending);
  }
  await pending;
  return overrides.get(runId) ?? new Map();
}

async function hydrate(runId: string): Promise<void> {
  const run: RunOverrides = new Map();
  overrides.set(runId, run);
  const rows = await db
    .select()
    .from(schema.refereeDecisions)
    .where(eq(schema.refereeDecisions.runId, runId))
    .orderBy(asc(schema.refereeDecisions.id));
  for (const row of rows) {
    if (!isSampleType(row.sampleType)) continue;
    const ref: SampleRef = { type: row.sampleType, id: row.sampleId };
    push(run, formatSampleId(ref), {
      decision: row.decision as DecisionKind,
      note: row.note,
      at: row.createdAt,
    });
  }
}

export async function getDecisions(runId: string): Promise<RunOverrides> {
  return ensureHydrated(runId);
}

export function record(
  runId: string,
  ref: SampleRef,
  decision: StoredDecision,
): void {
  const run = overrides.get(runId) ?? new Map<string, StoredDecision[]>();
  overrides.set(runId, run);
  push(run, formatSampleId(ref), decision);
}

function push(run: RunOverrides, sampleId: string, decision: StoredDecision): void {
  const list = run.get(sampleId);
  if (list) list.push(decision);
  else run.set(sampleId, [decision]);
}

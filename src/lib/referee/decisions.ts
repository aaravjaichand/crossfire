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

const DECISION_KINDS = new Set<string>(["approve", "redirect", "concede"]);

/**
 * Reads referee_decisions for a run on every call. There is deliberately no
 * process-local cache: the app runs on serverless instances that do not share
 * memory, and the thread polls, so a cached override would let one instance
 * serve a status the database has already moved past.
 */
export async function loadDecisions(runId: string): Promise<Map<string, StoredDecision[]>> {
  const rows = await db
    .select()
    .from(schema.refereeDecisions)
    .where(eq(schema.refereeDecisions.runId, runId))
    .orderBy(asc(schema.refereeDecisions.id));

  const bySample = new Map<string, StoredDecision[]>();
  for (const row of rows) {
    if (!isSampleType(row.sampleType) || !DECISION_KINDS.has(row.decision)) continue;
    const ref: SampleRef = { type: row.sampleType, id: row.sampleId };
    const key = formatSampleId(ref);
    const decision: StoredDecision = {
      decision: row.decision as DecisionKind,
      note: row.note,
      at: row.createdAt,
    };
    const list = bySample.get(key);
    if (list) list.push(decision);
    else bySample.set(key, [decision]);
  }
  return bySample;
}

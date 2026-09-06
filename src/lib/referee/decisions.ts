import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { SampleRef } from "./evidence-types";
import { formatSampleId, isSampleType } from "./sample-id";
import { isRemedy, isVerdict, type Remedy, type Verdict } from "./verdicts";

export type StoredDecision = {
  verdict: Verdict;
  remedy: Remedy | null;
  note: string | null;
  at: Date;
};

/**
 * Reads referee_decisions for a run on every call. There is deliberately no
 * process-local cache: the app runs on serverless instances that do not share
 * memory, and the thread polls, so a cached override would let one instance
 * serve a status the database has already moved past.
 *
 * Rows whose decision is not one of the four verdicts are skipped. Runs made
 * before the verdicts changed carry approve/redirect/concede, and mapping
 * those onto a status the current screen understands would put words in the
 * controller's mouth about a ruling they never made.
 */
export async function loadDecisions(runId: string): Promise<Map<string, StoredDecision[]>> {
  const rows = await db
    .select()
    .from(schema.refereeDecisions)
    .where(eq(schema.refereeDecisions.runId, runId))
    .orderBy(asc(schema.refereeDecisions.id));

  const bySample = new Map<string, StoredDecision[]>();
  for (const row of rows) {
    if (!isSampleType(row.sampleType) || !isVerdict(row.decision)) continue;
    const ref: SampleRef = { type: row.sampleType, id: row.sampleId };
    const key = formatSampleId(ref);
    const decision: StoredDecision = {
      verdict: row.decision,
      remedy: isRemedy(row.remedy) ? row.remedy : null,
      note: row.note,
      at: row.createdAt,
    };
    const list = bySample.get(key);
    if (list) list.push(decision);
    else bySample.set(key, [decision]);
  }
  return bySample;
}

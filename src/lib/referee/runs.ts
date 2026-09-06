import { asc, desc, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatSampleId, isSampleType } from "./sample-id";
import { isVerdict, type Verdict } from "./verdicts";

export type RunSummary = {
  id: number;
  name: string;
  createdAt: Date;
  status: string;
  total: number;
  open: number;
  defended: number;
  /** Gaps with no verdict on them yet — the work still waiting on a controller. */
  gap: number;
  /** Gaps the controller ruled an exception on: the run's findings. */
  exceptions: number;
};

type Counts = Pick<RunSummary, "total" | "open" | "defended" | "gap" | "exceptions">;

const EMPTY: Counts = { total: 0, open: 0, defended: 0, gap: 0, exceptions: 0 };

/** Newest runs first, with a status count per run for lists and the sidebar. */
export async function recentRuns(limit = 20): Promise<RunSummary[]> {
  const runs = await db
    .select()
    .from(schema.auditRuns)
    .orderBy(desc(schema.auditRuns.id))
    .limit(limit);
  if (runs.length === 0) return [];

  const runIds = runs.map((r) => r.id);
  const samples = await db
    .select({
      runId: schema.auditSamples.runId,
      sampleType: schema.auditSamples.sampleType,
      sampleId: schema.auditSamples.sampleId,
      status: schema.auditSamples.status,
    })
    .from(schema.auditSamples)
    .where(inArray(schema.auditSamples.runId, runIds));

  const verdicts = await latestVerdicts(runIds);

  const counts = new Map<number, Counts>();
  for (const s of samples) {
    const c = counts.get(s.runId) ?? { ...EMPTY };
    c.total += 1;
    const verdict = isSampleType(s.sampleType)
      ? verdicts.get(`${s.runId}|${formatSampleId({ type: s.sampleType, id: s.sampleId })}`)
      : undefined;
    if (s.status === "defended") c.defended += 1;
    else if (s.status === "gap") {
      // An exception keeps the sample at "gap", so the verdict is the only
      // thing separating a finding from work still outstanding.
      if (verdict === "exception") c.exceptions += 1;
      else c.gap += 1;
    }
    // "conceded" is what the pre-verdict referee wrote when it recorded an
    // unresolved finding, which is what an exception records now. No verdict
    // produces it any more; counting the leftovers here keeps the columns
    // adding up to the sample total instead of quietly dropping a row.
    else if (s.status === "conceded") c.exceptions += 1;
    else c.open += 1;
    counts.set(s.runId, c);
  }

  return runs.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    status: r.status,
    ...(counts.get(r.id) ?? EMPTY),
  }));
}

/**
 * The last verdict filed against each sample of these runs. Read in id order
 * and overwritten as it goes, so the newest ruling wins — the same rule the
 * run screen applies when it decides what to show beside a sample.
 */
async function latestVerdicts(runIds: number[]): Promise<Map<string, Verdict>> {
  const keys = runIds.map(String);
  const rows = await db
    .select()
    .from(schema.refereeDecisions)
    .where(inArray(schema.refereeDecisions.runId, keys))
    .orderBy(asc(schema.refereeDecisions.id));

  const byRunKey = new Map(keys.map((k, i) => [k, runIds[i]]));
  const latest = new Map<string, Verdict>();
  for (const row of rows) {
    // Pre-verdict decisions are skipped for the same reason loadDecisions
    // skips them: there is no honest mapping from "approve" onto a verdict.
    if (!isVerdict(row.decision) || !isSampleType(row.sampleType)) continue;
    const runId = byRunKey.get(row.runId);
    if (runId === undefined) continue;
    const ref = formatSampleId({ type: row.sampleType, id: row.sampleId });
    latest.set(`${runId}|${ref}`, row.decision);
  }
  return latest;
}

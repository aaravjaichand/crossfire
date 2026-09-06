import { desc, inArray } from "drizzle-orm";
import { db, schema } from "@/db";

export type RunSummary = {
  id: number;
  name: string;
  createdAt: Date;
  status: string;
  total: number;
  open: number;
  defended: number;
  gap: number;
  conceded: number;
};

type Counts = Pick<RunSummary, "total" | "open" | "defended" | "gap" | "conceded">;

const EMPTY: Counts = { total: 0, open: 0, defended: 0, gap: 0, conceded: 0 };

/** Newest runs first, with a status count per run for lists and the sidebar. */
export async function recentRuns(limit = 20): Promise<RunSummary[]> {
  const runs = await db
    .select()
    .from(schema.auditRuns)
    .orderBy(desc(schema.auditRuns.id))
    .limit(limit);
  if (runs.length === 0) return [];

  const samples = await db
    .select({ runId: schema.auditSamples.runId, status: schema.auditSamples.status })
    .from(schema.auditSamples)
    .where(
      inArray(
        schema.auditSamples.runId,
        runs.map((r) => r.id),
      ),
    );

  const counts = new Map<number, Counts>();
  for (const s of samples) {
    const c = counts.get(s.runId) ?? { ...EMPTY };
    c.total += 1;
    if (s.status === "defended") c.defended += 1;
    else if (s.status === "gap") c.gap += 1;
    else if (s.status === "conceded") c.conceded += 1;
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

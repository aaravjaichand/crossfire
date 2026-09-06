// The two cover-sheet fields that live on audit_runs and not on RunView: the
// PRNG seed the sample was drawn with, and when the run started. A binder
// without the seed cannot be reproduced from itself, which is most of what a
// workpaper cover sheet is for.
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { BinderExtras } from "./assemble";

export async function loadRunInputs(runId: string): Promise<BinderExtras> {
  if (!/^\d+$/.test(runId)) return {};
  const [row] = await db
    .select({ seed: schema.auditRuns.seed, startedAt: schema.auditRuns.createdAt })
    .from(schema.auditRuns)
    .where(eq(schema.auditRuns.id, Number(runId)));
  if (!row) return {};
  return { seed: row.seed, startedAt: row.startedAt };
}

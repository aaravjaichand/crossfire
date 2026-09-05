// Persists one audit run atomically. All 25 questions must be prepared
// (sampled, scored, and phrased) *before* calling this: everything below is
// a single database transaction, so an interrupted run (crash, thrown
// error, killed process) leaves zero partial audit_samples/audit_exchanges
// rows behind — either the whole run lands, or none of it does.
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { SampleCandidate } from "./sampler";
import { centsToDecimalString } from "./util";

export type PreparedSample = {
  candidate: SampleCandidate;
  templateId: string;
  /** Final question text, LLM-phrased and citation-guaranteed. */
  question: string;
};

export type PersistRunInput = {
  name: string;
  seed: number;
  samples: PreparedSample[];
  /**
   * Test-only: throw after inserting this many samples, to prove the
   * transaction rolls back cleanly. Never set outside persist.check.ts.
   */
  failAfterSampleCount?: number;
};

export type PersistedRun = { runId: number };

export async function persistRun(input: PersistRunInput): Promise<PersistedRun> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(schema.auditRuns)
      .values({
        name: input.name,
        status: "running",
        sampleCount: input.samples.length,
        notes: `seed=${input.seed}`,
      })
      .returning();

    let inserted = 0;
    for (const prepared of input.samples) {
      const [sampleRow] = await tx
        .insert(schema.auditSamples)
        .values({
          runId: run.id,
          sampleType: prepared.candidate.sampleType,
          sampleId: prepared.candidate.sampleId,
          amount: centsToDecimalString(prepared.candidate.amountCents),
          riskScore: prepared.candidate.riskScore,
          riskReasons: prepared.candidate.riskReasons,
        })
        .returning();

      await tx.insert(schema.auditExchanges).values({
        runId: run.id,
        sampleId: sampleRow.id,
        turn: 1,
        role: "auditor",
        questionTemplateId: prepared.templateId,
        content: prepared.question,
      });

      inserted++;
      if (input.failAfterSampleCount !== undefined && inserted >= input.failAfterSampleCount) {
        throw new Error(
          `[persist probe] simulated failure after ${inserted} sample(s); the transaction must roll back`,
        );
      }
    }

    await tx.update(schema.auditRuns).set({ status: "complete" }).where(eq(schema.auditRuns.id, run.id));
    return { runId: run.id };
  });
}

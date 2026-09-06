// Persists one audit run atomically. All 25 questions must be prepared
// (sampled, scored, and phrased) *before* calling this: everything below is
// a single database transaction, so an interrupted run (crash, thrown
// error, killed process) leaves zero partial audit_samples/audit_exchanges
// rows behind — either the whole run lands, or none of it does.
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { CYCLES, type AuditCycle } from "./cycles";
import type { AuditProcedure } from "./questions";
import type { SampleCandidate } from "./sampler";
import { centsToDecimalString } from "./util";

export type PreparedSample = {
  candidate: SampleCandidate;
  templateId: string;
  procedure: AuditProcedure;
  /** Final question text, LLM-phrased and citation-guaranteed. */
  question: string;
};

export type PersistRunInput = {
  name: string;
  seed: number;
  samples: PreparedSample[];
  /** Materiality in cents the run was drawn at. */
  materialityCents?: number;
  /** Target sample size the run asked for (picks may exceed it). */
  sampleSize?: number;
  /** Cycles the run was scoped to. */
  cycles?: readonly AuditCycle[];
  /**
   * Status to leave the run in. "complete" is right for a run that is fully
   * written by the time this returns (the sampling-only CLI path); the engine
   * passes "running" because the accountant turns come afterwards.
   */
  status?: "running" | "complete";
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
        seed: input.seed,
        ...(input.materialityCents === undefined ? {} : { materiality: input.materialityCents }),
        sampleSize: input.sampleSize ?? input.samples.length,
        cycles: [...(input.cycles ?? CYCLES)],
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
        procedure: prepared.procedure,
        content: prepared.question,
      });

      inserted++;
      if (input.failAfterSampleCount !== undefined && inserted >= input.failAfterSampleCount) {
        throw new Error(
          `[persist probe] simulated failure after ${inserted} sample(s); the transaction must roll back`,
        );
      }
    }

    await tx
      .update(schema.auditRuns)
      .set({ status: input.status ?? "complete" })
      .where(eq(schema.auditRuns.id, run.id));
    return { runId: run.id };
  });
}

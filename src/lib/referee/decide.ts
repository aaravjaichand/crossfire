import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { SampleRef } from "./evidence-types";
import { resolveRunId, type SampleStatus } from "./data";
import type { DecisionKind } from "./decisions";
import { mockSampleIds, MOCK_RUN_ID } from "./mock-run";
import { findRealSample } from "./real-run";
import { formatSampleId, isSampleType } from "./sample-id";

// The referee decision, without the server-action wrapper in actions.ts, so
// the checks can drive it outside a request.

export type DecisionInput = {
  runId: string;
  sampleType: string;
  sampleId: number;
};

/**
 * Decisions answer with a result rather than throwing. A thrown server action
 * shows its message in the browser in development and a bare "an error
 * occurred" in production; neither is a useful failure state, and the first
 * leaks database detail. Failures are logged on the server and answered with a
 * message written for the referee.
 */
export type DecisionResult =
  | { ok: true; runKey: string }
  | { ok: false; message: string };

const STATUS_AFTER: Record<DecisionKind, SampleStatus> = {
  approve: "defended",
  redirect: "open",
  concede: "conceded",
};

const GENERIC_FAILURE = "The decision could not be recorded. Try again.";
const NOT_IN_RUN = "That sample is not part of this run.";

export async function recordDecision(
  input: DecisionInput,
  decision: DecisionKind,
  note: string | null,
): Promise<DecisionResult> {
  const ref = parseInput(input);
  if (!ref) return { ok: false, message: "That sample reference is not valid." };

  try {
    const resolved = resolveRunId(input.runId);

    if (resolved.kind === "mock") {
      if (!mockSampleIds().has(formatSampleId(ref))) return { ok: false, message: NOT_IN_RUN };
      await db.insert(schema.refereeDecisions).values({
        runId: MOCK_RUN_ID,
        sampleType: ref.type,
        sampleId: ref.id,
        decision,
        note,
      });
      return { ok: true, runKey: MOCK_RUN_ID };
    }

    const runKey = runKeyFor(resolved.id);
    if (!runKey) return { ok: false, message: GENERIC_FAILURE };

    const match = await findRealSample(resolved.id, ref);
    // Either the run does not exist or it does not contain this sample. Both
    // are the same answer to the referee, and neither writes anything.
    if (!match) return { ok: false, message: NOT_IN_RUN };

    // The decision and the status it implies land together or not at all, so
    // audit_samples.status cannot disagree with the last decision on file.
    await db.transaction(async (tx) => {
      await tx.insert(schema.refereeDecisions).values({
        runId: runKey,
        sampleType: ref.type,
        sampleId: ref.id,
        decision,
        note,
      });
      await tx
        .update(schema.auditSamples)
        .set({ status: STATUS_AFTER[decision] })
        .where(
          and(
            eq(schema.auditSamples.id, match.auditSampleId),
            eq(schema.auditSamples.runId, resolved.id),
          ),
        );
    });

    return { ok: true, runKey };
  } catch (error) {
    console.error("[referee] recording a decision failed", {
      runId: input.runId,
      sample: formatSampleId(ref),
      decision,
      error,
    });
    return { ok: false, message: GENERIC_FAILURE };
  }
}

export function normaliseNote(note: unknown): string | null {
  const trimmed = typeof note === "string" ? note.trim() : "";
  return trimmed.length === 0 ? null : trimmed.slice(0, 500);
}

function parseInput(input: DecisionInput): SampleRef | null {
  if (!input || typeof input.runId !== "string" || input.runId.length === 0) return null;
  if (typeof input.sampleType !== "string" || !isSampleType(input.sampleType)) return null;
  if (!Number.isSafeInteger(input.sampleId) || input.sampleId <= 0) return null;
  return { type: input.sampleType, id: input.sampleId };
}

/**
 * referee_decisions.run_id is text and carries no foreign key, per the Worker C
 * schema. The numeric audit_runs id is converted explicitly and checked to
 * round-trip, so nothing but digits is ever filed as a real run key.
 */
function runKeyFor(runDbId: number): string | null {
  if (!Number.isSafeInteger(runDbId) || runDbId <= 0) return null;
  const key = String(runDbId);
  return /^\d+$/.test(key) ? key : null;
}

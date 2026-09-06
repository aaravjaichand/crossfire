import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { SampleRef } from "./evidence-types";
import { counterpartyOf, getSample, primaryGap, resolveRunId } from "./data";
import { mockSampleIds, MOCK_RUN_ID } from "./mock-run";
import { findRealSample } from "./real-run";
import { formatSampleId, isSampleType } from "./sample-id";
import {
  isRemedy,
  isVerdict,
  REQUIRES_NOTE,
  REQUIRES_REMEDY,
  STATUS_AFTER,
  teaches,
  VERDICT_LABEL,
  type Remedy,
  type Verdict,
} from "./verdicts";

// The controller's ruling, without the server-action wrapper in actions.ts, so
// the checks can drive it outside a request.

export type DecisionInput = {
  runId: string;
  sampleType: string;
  sampleId: number;
};

export type RulingDetail = {
  note?: string | null;
  remedy?: string | null;
};

/**
 * Decisions answer with a result rather than throwing. A thrown server action
 * shows its message in the browser in development and a bare "an error
 * occurred" in production; neither is a useful failure state, and the first
 * leaks database detail. Failures are logged on the server and answered with a
 * message written for the controller.
 */
export type DecisionResult =
  | { ok: true; runKey: string }
  | { ok: false; message: string };

const GENERIC_FAILURE = "The ruling could not be recorded. Try again.";
const NOT_IN_RUN = "That sample is not part of this run.";

export async function recordDecision(
  input: DecisionInput,
  verdict: Verdict,
  detail: RulingDetail = {},
): Promise<DecisionResult> {
  const ref = parseInput(input);
  if (!ref) return { ok: false, message: "That sample reference is not valid." };
  if (!isVerdict(verdict)) return { ok: false, message: "That is not one of the four verdicts." };

  const note = normaliseNote(detail.note);
  if (REQUIRES_NOTE[verdict] && !note) {
    return { ok: false, message: noteRequiredMessage(verdict) };
  }

  const remedy = isRemedy(detail.remedy) ? detail.remedy : null;
  if (REQUIRES_REMEDY[verdict] && !remedy) {
    return { ok: false, message: "An exception needs a remedy." };
  }
  // A remedy on any other verdict would be filed against a sample that has no
  // finding to remedy, so it is dropped rather than stored.
  const storedRemedy = REQUIRES_REMEDY[verdict] ? remedy : null;

  try {
    const resolved = resolveRunId(input.runId);
    const runKey = resolved.kind === "mock" ? MOCK_RUN_ID : runKeyFor(resolved.id);
    if (!runKey) return { ok: false, message: GENERIC_FAILURE };

    if (resolved.kind === "mock" && !mockSampleIds().has(formatSampleId(ref))) {
      return { ok: false, message: NOT_IN_RUN };
    }

    // Either the run does not exist or it does not contain this sample. Both
    // are the same answer to the controller, and neither writes anything. The
    // mock run has no audit_samples rows at all, so it has nothing to update.
    const realRunDbId = resolved.kind === "real" ? resolved.id : null;
    const match = realRunDbId === null ? null : await findRealSample(realRunDbId, ref);
    if (realRunDbId !== null && !match) return { ok: false, message: NOT_IN_RUN };

    // The gap kind and counterparty the rule is filed under are read from the
    // sample as the controller saw it, before anything is written.
    const lesson = teaches(verdict) ? await learnedRuleFor(input.runId, ref) : null;

    // The ruling, the status it implies, the follow-up note the engine reads,
    // and the rule the accountant learns from land together or not at all, so
    // audit_samples can never disagree with the last ruling on file.
    await db.transaction(async (tx) => {
      await tx.insert(schema.refereeDecisions).values({
        runId: runKey,
        sampleType: ref.type,
        sampleId: ref.id,
        decision: verdict,
        remedy: storedRemedy,
        note,
      });

      if (match && realRunDbId !== null) {
        await tx
          .update(schema.auditSamples)
          .set({
            status: STATUS_AFTER[verdict],
            // needs_more hands the note to the engine, which re-runs the
            // accountant against it. Every other verdict settles the sample,
            // so any note left over from an earlier needs_more is cleared.
            pendingFollowUp: verdict === "needs_more" ? note : null,
          })
          .where(
            and(
              eq(schema.auditSamples.id, match.auditSampleId),
              eq(schema.auditSamples.runId, realRunDbId),
            ),
          );
      }

      if (lesson) {
        await tx.insert(schema.learnedRules).values({
          runId: runKey,
          sampleType: ref.type,
          sampleId: ref.id,
          gapKind: lesson.gapKind,
          counterparty: lesson.counterparty,
          remedy: storedRemedy,
          note,
          verdict,
        });
      }
    });

    return { ok: true, runKey };
  } catch (error) {
    console.error("[referee] recording a ruling failed", {
      runId: input.runId,
      sample: formatSampleId(ref),
      verdict,
      error,
    });
    return { ok: false, message: GENERIC_FAILURE };
  }
}

export function normaliseNote(note: unknown): string | null {
  const trimmed = typeof note === "string" ? note.trim() : "";
  return trimmed.length === 0 ? null : trimmed.slice(0, 500);
}

function noteRequiredMessage(verdict: Verdict): string {
  return verdict === "needs_more"
    ? "Needs more requires a note telling the accountant where to look."
    : `${VERDICT_LABEL[verdict]} requires a note saying what you accepted.`;
}

type Lesson = { gapKind: string; counterparty: string };

/**
 * getSample() is the one path that reads both the mock run and a real run, so
 * a rule learned on the walkthrough is shaped exactly like one learned on a
 * real run. A sample that cannot be read still teaches something — the verdict
 * and the note — so this falls back rather than skipping the row.
 */
async function learnedRuleFor(runId: string, ref: SampleRef): Promise<Lesson> {
  try {
    const sample = await getSample(runId, formatSampleId(ref));
    if (!sample) return { gapKind: "other", counterparty: ref.type };
    return { gapKind: primaryGap(sample).kind, counterparty: counterpartyOf(sample) };
  } catch (error) {
    console.error("[referee] reading the sample for a learned rule failed", { runId, error });
    return { gapKind: "other", counterparty: ref.type };
  }
}

function parseInput(input: DecisionInput): SampleRef | null {
  if (!input || typeof input.runId !== "string" || input.runId.length === 0) return null;
  if (typeof input.sampleType !== "string" || !isSampleType(input.sampleType)) return null;
  if (!Number.isSafeInteger(input.sampleId) || input.sampleId <= 0) return null;
  return { type: input.sampleType, id: input.sampleId };
}

/**
 * referee_decisions.run_id and learned_rules.run_id are text and carry no
 * foreign key, since the mock run has no audit_runs row. The numeric audit_runs
 * id is converted explicitly and checked to round-trip, so nothing but digits
 * is ever filed as a real run key.
 */
function runKeyFor(runDbId: number): string | null {
  if (!Number.isSafeInteger(runDbId) || runDbId <= 0) return null;
  const key = String(runDbId);
  return /^\d+$/.test(key) ? key : null;
}

export type { Remedy, Verdict };

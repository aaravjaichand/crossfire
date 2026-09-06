"use server";

import { revalidatePath } from "next/cache";
import { recordDecision, type DecisionInput, type DecisionResult } from "./decide";
import { isVerdict } from "./verdicts";

export type { DecisionInput, DecisionResult } from "./decide";

export type VerdictSubmission = {
  verdict: string;
  note?: string;
  remedy?: string;
};

/**
 * One action for all four verdicts. The client sends what the controller
 * chose; decide.ts is what decides whether that verdict is allowed to carry a
 * note or a remedy, so a hand-built request cannot file a remedy against a
 * sufficient verdict or skip a required note.
 */
export async function submitVerdict(
  input: DecisionInput,
  submission: VerdictSubmission,
): Promise<DecisionResult> {
  if (!isVerdict(submission?.verdict)) {
    return { ok: false, message: "That is not one of the four verdicts." };
  }

  const result = await recordDecision(input, submission.verdict, {
    note: submission.note,
    remedy: submission.remedy,
  });

  // Revalidating the run key rather than the requested path keeps a ruling
  // reached through an alias of the mock run from invalidating some other page.
  if (result.ok) revalidatePath(`/audit/${result.runKey}`);
  return result;
}

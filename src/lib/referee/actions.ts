"use server";

import { revalidatePath } from "next/cache";
import { normaliseNote, recordDecision, type DecisionInput, type DecisionResult } from "./decide";

export type { DecisionInput, DecisionResult } from "./decide";

export async function approve(input: DecisionInput): Promise<DecisionResult> {
  return run(input, "approve", null);
}

export async function redirect(input: DecisionInput, note: string): Promise<DecisionResult> {
  const trimmed = normaliseNote(note);
  if (!trimmed) {
    return { ok: false, message: "A redirect needs a note telling the accountant where to look." };
  }
  return run(input, "redirect", trimmed);
}

export async function concede(input: DecisionInput): Promise<DecisionResult> {
  return run(input, "concede", null);
}

async function run(
  input: DecisionInput,
  decision: "approve" | "redirect" | "concede",
  note: string | null,
): Promise<DecisionResult> {
  const result = await recordDecision(input, decision, note);
  // Revalidating the run key rather than the requested path keeps a decision
  // reached through an alias of the mock run from invalidating some other page.
  if (result.ok) revalidatePath(`/audit/${result.runKey}`);
  return result;
}

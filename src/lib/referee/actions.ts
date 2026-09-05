"use server";

import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import type { SampleRef } from "./evidence-types";
import { isSampleType } from "./sample-id";
import { ensureHydrated, record, type DecisionKind } from "./decisions";

export type DecisionInput = {
  runId: string;
  sampleType: string;
  sampleId: number;
};

export async function approve(input: DecisionInput): Promise<void> {
  await decide(input, "approve", null);
}

export async function redirect(input: DecisionInput, note: string): Promise<void> {
  const trimmed = note.trim();
  if (trimmed.length === 0) throw new Error("A redirect needs a note telling the accountant where to look.");
  await decide(input, "redirect", trimmed.slice(0, 500));
}

export async function concede(input: DecisionInput): Promise<void> {
  await decide(input, "concede", null);
}

async function decide(
  input: DecisionInput,
  decision: DecisionKind,
  note: string | null,
): Promise<void> {
  const ref = validate(input);
  // Hydrate before the insert so the cache does not read its own new row back
  // and count the decision twice.
  await ensureHydrated(input.runId);
  const [row] = await db
    .insert(schema.refereeDecisions)
    .values({
      runId: input.runId,
      sampleType: ref.type,
      sampleId: ref.id,
      decision,
      note,
    })
    .returning({ createdAt: schema.refereeDecisions.createdAt });
  record(input.runId, ref, { decision, note, at: row.createdAt });
  revalidatePath(`/audit/${input.runId}`);
}

function validate(input: DecisionInput): SampleRef {
  if (!input.runId) throw new Error("Missing run id.");
  if (!isSampleType(input.sampleType)) throw new Error(`Unknown sample type ${input.sampleType}.`);
  if (!Number.isInteger(input.sampleId) || input.sampleId <= 0) {
    throw new Error(`Invalid sample id ${input.sampleId}.`);
  }
  return { type: input.sampleType, id: input.sampleId };
}

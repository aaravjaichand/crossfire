"use server";

/**
 * Filing a ruling from a draft card on the assistant page. The boundary is
 * that a human click files, not which page the click is on: this calls the
 * same server action the run screen's verdict buttons call, so one code path
 * writes referee_decisions and learned_rules and the same refusals apply.
 *
 * Not a tool. Nothing in the tool catalog imports this module, which
 * assistant.check.ts asserts at the source level.
 */
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { submitVerdict } from "@/lib/referee/actions";
import { parseSampleId } from "@/lib/referee/sample-id";
import { isRemedy } from "@/lib/referee/verdicts";
import { getMessage, updateDraft } from "./threads";

export type FileDraftInput = {
  messageId: number;
  note: string;
  remedy?: string;
};

export type FileDraftResult =
  | { ok: true; decisionId: number; runKey: string; sampleRef: string }
  | { ok: false; message: string };

export async function fileDraft(input: FileDraftInput): Promise<FileDraftResult> {
  const messageId = typeof input?.messageId === "number" ? input.messageId : NaN;
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return { ok: false, message: "That draft could not be found." };

  const message = await getMessage(messageId);
  const draft = message?.draft;
  if (!draft || draft.kind === "start_run") return { ok: false, message: "That message carries no draft to file." };
  if (draft.filedDecisionId) {
    return { ok: false, message: `This draft was already filed as referee_decisions#${draft.filedDecisionId}.` };
  }
  const ref = parseSampleId(draft.sampleRef);
  if (!ref) return { ok: false, message: "That draft's sample reference is not valid." };

  const note = typeof input.note === "string" ? input.note : draft.text;
  const remedy = isRemedy(input.remedy) ? input.remedy : draft.remedy;

  const result = await submitVerdict(
    { runId: draft.runId, sampleType: ref.type, sampleId: ref.id },
    { verdict: draft.verdict, note, ...(remedy ? { remedy } : {}) },
  );
  if (!result.ok) return result;

  const [decision] = await db
    .select({ id: schema.refereeDecisions.id })
    .from(schema.refereeDecisions)
    .where(
      and(
        eq(schema.refereeDecisions.runId, result.runKey),
        eq(schema.refereeDecisions.sampleType, ref.type),
        eq(schema.refereeDecisions.sampleId, ref.id),
      ),
    )
    .orderBy(desc(schema.refereeDecisions.id))
    .limit(1);
  const decisionId = decision?.id ?? 0;

  try {
    await updateDraft(messageId, { ...draft, text: note, ...(remedy ? { remedy } : {}), filedDecisionId: decisionId });
  } catch (error) {
    // The ruling is on file either way; the card just cannot show it as filed
    // after a reload. Worth a log line, not a failure in front of the controller.
    console.error("[assistant] recording the filed decision on the draft failed", { messageId, error });
  }
  return { ok: true, decisionId, runKey: result.runKey, sampleRef: draft.sampleRef };
}

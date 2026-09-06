/**
 * A draft reaching the run screen: a persisted message row, not a URL
 * parameter. The row is loaded and verified here — its run key must equal
 * the run being viewed and its sample the selected one — and anything else is
 * ignored silently, so a draft cannot be aimed at a sample it was not written
 * about. The run screen never mutates the row.
 */
import type { Remedy } from "@/lib/referee/verdicts";
import { getMessage } from "./threads";
import type { DraftVerdict, RulingDraft } from "./types";

export type VerifiedDraft = {
  messageId: number;
  /** The sample the draft was written about, which is the one it was verified against. */
  sampleRef: string;
  verdict: DraftVerdict;
  note: string;
  remedy?: Remedy;
};

export function verifyDraft(
  draft: RulingDraft | undefined,
  messageId: number,
  runKey: string,
  sampleId: string | null,
): VerifiedDraft | null {
  if (!draft || (draft.kind !== "note" && draft.kind !== "remedy")) return null;
  if (draft.filedDecisionId) return null;
  if (draft.runId !== runKey) return null;
  if (!sampleId || draft.sampleRef !== sampleId) return null;
  return {
    messageId,
    sampleRef: draft.sampleRef,
    verdict: draft.verdict,
    note: draft.text,
    ...(draft.remedy ? { remedy: draft.remedy } : {}),
  };
}

export async function loadVerifiedDraft(
  raw: string | string[] | undefined,
  runKey: string,
  sampleId: string | null,
): Promise<VerifiedDraft | null> {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) return null;
  const messageId = Number(value);
  try {
    const message = await getMessage(messageId);
    if (!message?.draft || message.draft.kind === "start_run") return null;
    return verifyDraft(message.draft, messageId, runKey, sampleId);
  } catch (error) {
    console.error("[assistant] loading a draft for the run screen failed", { messageId, error });
    return null;
  }
}

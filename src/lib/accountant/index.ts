/**
 * The Accountant agent. `gatherEvidence` is deterministic database work with no
 * LLM; `defend` is that plus exactly one model call to write the paragraph.
 */
import { gatherEvidence } from "./gather";
import { writeDefense } from "./defend";
import type { EvidenceBundle, SampleRef } from "./types";

export async function defend(sample: SampleRef): Promise<EvidenceBundle> {
  return writeDefense(await gatherEvidence(sample));
}

export { gatherEvidence, MATCHING } from "./gather";
export { writeDefense, buildDefensePrompt } from "./defend";
export { formatBundle } from "./format";
export { parseSampleId, formatSampleId, SAMPLE_ID_HELP } from "./sample";
export { toCents, usd } from "./money";
export type {
  Citation,
  EvidenceBundle,
  Gap,
  GapKind,
  SampleRef,
  SampleType,
} from "./types";

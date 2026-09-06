/**
 * The Accountant agent. `gatherEvidence` is deterministic database work with no
 * LLM; `defend` is that plus exactly one model call to write the paragraph.
 */
import { gatherEvidence } from "./gather";
import { writeDefense, type DefendOptions } from "./defend";
import type { EvidenceBundle, SampleRef } from "./types";

export async function defend(
  sample: SampleRef,
  options: DefendOptions = {},
): Promise<EvidenceBundle> {
  return writeDefense(await gatherEvidence(sample), options);
}

export { gatherEvidence, MATCHING, classifyLedgerRows } from "./gather";
export {
  writeDefense,
  buildDefensePrompt,
  llmDisabled,
  llmForcedToFail,
  type DefendOptions,
} from "./defend";
export {
  buildFallbackDefense,
  finalizeDefense,
  isFactualSentence,
  keepOnlyCitedRows,
  splitSentences,
  validateDefense,
} from "./citations";
export {
  classifyPaymentLink,
  describeRejection,
  paymentWindow,
  type PaymentCandidate,
  type PaymentLink,
} from "./matching";
export { formatBundle } from "./format";
export { parseSampleId, formatSampleId, SAMPLE_ID_HELP } from "./sample";
export { toCents, usd } from "./money";
export type {
  Citation,
  DefenseSource,
  EvidenceBundle,
  Gap,
  GapKind,
  SampleRef,
  SampleType,
} from "./types";

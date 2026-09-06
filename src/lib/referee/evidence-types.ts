// Was a mirror of src/lib/accountant/types.ts while that work was in flight.
// Now that it has merged, this re-exports the canonical types so the referee
// tree keeps a single import path.
import type { EvidenceBundle } from "@/lib/accountant/types";

export type {
  Citation,
  EvidenceBundle,
  Gap,
  GapKind,
  SampleRef,
  SampleType,
} from "@/lib/accountant/types";

/**
 * Whether the accountant's paragraph was written by the model or assembled
 * from the gathered rows because the model's draft did not cite them.
 *
 * Structurally identical to the type Worker A's "Run stepping" adds to
 * accountant/types.ts, `reason` optional included: A omits it when the source
 * is "model", and a required field here would intersect into something A never
 * writes. Declared locally only because this PR merges first; once the field is
 * on EvidenceBundle both this and the intersection below are redundant.
 */
export type DefenseSource = {
  source: "model" | "fallback";
  /** Why the fallback was used. Absent when source is "model". */
  reason?: string;
};

/**
 * An EvidenceBundle as it comes back off audit_exchanges.evidence, including
 * fields the canonical type does not carry yet. Rows written before the engine
 * recorded it simply have none, which is why it is optional.
 */
export type ParsedEvidenceBundle = EvidenceBundle & {
  defenseSource?: DefenseSource;
};

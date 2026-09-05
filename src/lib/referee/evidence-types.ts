// Was a mirror of src/lib/accountant/types.ts while that work was in flight.
// Now that it has merged, this re-exports the canonical types so the referee
// tree keeps a single import path.
export type {
  Citation,
  EvidenceBundle,
  Gap,
  GapKind,
  SampleRef,
  SampleType,
} from "@/lib/accountant/types";

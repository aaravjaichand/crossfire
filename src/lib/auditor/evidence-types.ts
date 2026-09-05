// Re-exports the canonical evidence types from the merged accountant module.
// Worker B code should import from here (not from "@/lib/accountant"
// directly) so this file stays the single seam if that ever changes.
export type {
  Citation,
  EvidenceBundle,
  Gap,
  GapKind,
  SampleRef,
  SampleType,
} from "@/lib/accountant/types";

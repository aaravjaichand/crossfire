// The transaction cycles a run can be scoped to. One per sample type the
// sampler can draw from, so a cycle selection maps onto something the engine
// can act on rather than a label with no effect.
//
// This lives outside src/lib/engine so the new-run form keeps its options when
// the engine's startRun is replaced by the real implementation.

import type { SampleType } from "./evidence-types";

export type Cycle = { id: string; label: string; sampleType: SampleType };

export const CYCLES: Cycle[] = [
  { id: "purchases", label: "Purchases and payables", sampleType: "invoice" },
  { id: "cash", label: "Cash and bank", sampleType: "bank_transaction" },
  { id: "revenue", label: "Revenue and Dodo settlements", sampleType: "dodo_transaction" },
];

export const DEFAULT_CYCLE_IDS = CYCLES.map((c) => c.id);

export function cycleLabel(id: string): string {
  return CYCLES.find((c) => c.id === id)?.label ?? id;
}

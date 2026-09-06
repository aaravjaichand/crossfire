// Display names for the transaction cycles a run can be scoped to.
//
// The ids belong to the engine: src/lib/auditor/cycles.ts owns CYCLES, and a
// cycle id in audit_runs.cycles means something only because the sampler
// matches on it. They are imported from there rather than restated, so the
// form can never offer a cycle the sampler does not know. This file exists to
// give those ids a label for the new-run form and the run header.
//
// A's split, which the labels must not contradict:
//   purchases  invoices, and bank payments whose counterparty is a vendor
//   cash       every other bank row: payout settlements, fees, interest, and
//              anything paid to a counterparty that is not a known vendor
//   revenue    Dodo Payments rows
//   payroll    bank rows on the payroll account
//
// Note what that rules out: a cycle is not a sample type. "purchases" spans
// invoices and bank rows, and three of the four draw on bank_transactions, so
// nothing here may carry a cycle-to-table mapping. It would be wrong, and the
// form would be promising a split the sampler does not implement.

import { CYCLES as ENGINE_CYCLES, type AuditCycle } from "@/lib/auditor/cycles";

export type Cycle = { id: AuditCycle; label: string };

const LABELS: Record<AuditCycle, string> = {
  purchases: "Purchases and payables",
  cash: "Cash and bank",
  revenue: "Revenue and Dodo settlements",
  payroll: "Payroll",
};

export function cycleLabel(id: string): string {
  return LABELS[id as AuditCycle] ?? id;
}

/** In the engine's canonical order, so a stored list round-trips unchanged. */
export const CYCLES: Cycle[] = ENGINE_CYCLES.map((id) => ({ id, label: LABELS[id] }));

export const DEFAULT_CYCLE_IDS: AuditCycle[] = [...ENGINE_CYCLES];

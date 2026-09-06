// Display names for the transaction cycles a run can be scoped to.
//
// The ids themselves belong to the engine: src/lib/auditor/cycles.ts owns
// CYCLES, and a cycle id in audit_runs.cycles means something only because the
// sampler matches on it. This file exists so the new-run form and the run
// header have something to render, and for no other reason.
//
// AT REBASE, once Worker A's run-engine has merged: import CYCLES from
// "@/lib/auditor/cycles" and derive CYCLE_IDS from it, so the ids have exactly
// one definition. Keep LABELS here. Do not edit A's file.
//
// A's split, which the labels below must not contradict:
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

export type Cycle = { id: string; label: string };

const LABELS: Record<string, string> = {
  purchases: "Purchases and payables",
  cash: "Cash and bank",
  revenue: "Revenue and Dodo settlements",
  payroll: "Payroll",
};

// Mirrors src/lib/auditor/cycles.ts on Worker A's branch, in its canonical
// order. Replaced by an import from that file at rebase.
const CYCLE_IDS = ["purchases", "cash", "revenue", "payroll"];

export function cycleLabel(id: string): string {
  return LABELS[id] ?? id;
}

export const CYCLES: Cycle[] = CYCLE_IDS.map((id) => ({ id, label: cycleLabel(id) }));

export const DEFAULT_CYCLE_IDS = [...CYCLE_IDS];

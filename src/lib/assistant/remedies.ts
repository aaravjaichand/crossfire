/**
 * The remedy the assistant pre-selects for an exception, by gap kind. A fixed
 * table in the house style of src/lib/referee/adjustments.ts: the human still
 * clicks the remedy that files, this only decides which radio starts checked.
 */
import type { GapKind } from "@/lib/accountant/types";
import type { Remedy } from "@/lib/referee/verdicts";

export const REMEDY_BY_GAP_KIND: Record<GapKind, Remedy> = {
  duplicate_payment: "recover_cash",
  rate_mismatch: "recover_cash",
  missing_approval: "fix_control",
  outside_contract_term: "post_entry",
  duplicate_invoice_month: "post_entry",
  missing_ledger_entry: "post_entry",
  no_bank_match: "post_entry",
  unknown_counterparty: "investigate",
  payout_mismatch: "investigate",
  no_matching_invoice: "investigate",
  other: "investigate",
};

export function remedyFor(kind: string): Remedy {
  return REMEDY_BY_GAP_KIND[kind as GapKind] ?? REMEDY_BY_GAP_KIND.other;
}

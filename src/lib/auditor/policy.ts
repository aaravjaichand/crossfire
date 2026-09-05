// Deterministic follow-up policy. No LLM: given the accountant's evidence
// bundle and the current turn number, decide whether the auditor accepts
// the defense, pushes back with a targeted follow-up, or escalates to the
// human referee.
import type { EvidenceBundle, GapKind } from "./evidence-types";

export type PolicyAction = "accept" | "push_back" | "escalate";
export type PolicyDecision = { action: PolicyAction; followUp?: string };

// Gaps a further, more targeted search could plausibly close.
const CLOSEABLE_GAPS: GapKind[] = ["missing_ledger_entry", "no_bank_match", "no_matching_invoice"];

// Gaps that are structural (a fact about the books, not a search miss) and
// always go straight to the referee.
const STRUCTURAL_GAPS: GapKind[] = [
  "duplicate_payment",
  "rate_mismatch",
  "missing_approval",
  "unknown_counterparty",
  "outside_contract_term",
  "duplicate_invoice_month",
  "payout_mismatch",
];

const FOLLOW_UP_TEMPLATES: Partial<Record<GapKind, string>> = {
  missing_ledger_entry:
    "The ledger has no entry for this. Search again and cite the specific ledger_entries row, or confirm it is genuinely missing.",
  no_bank_match:
    "No bank transaction matches this yet. Check nearby dates and amounts in the bank feed and cite the matching row, or confirm none exists.",
  no_matching_invoice:
    "No invoice was found. Check the vendor's other invoices for this period and cite the matching one, or confirm none exists.",
};

export function decide(bundle: EvidenceBundle, turn: number): PolicyDecision {
  const gaps = bundle.gaps ?? [];
  const hasAmountCitation = bundle.citations.some((c) => c.field.toLowerCase().includes("amount"));

  if (gaps.length === 0 && hasAmountCitation) {
    return { action: "accept" };
  }

  const hasStructuralGap = gaps.some((g) => STRUCTURAL_GAPS.includes(g.kind));
  if (hasStructuralGap || turn >= 3) {
    return { action: "escalate" };
  }

  if (gaps.length === 0) {
    // No gaps reported, but nothing actually cites the amount: push for that.
    return {
      action: "push_back",
      followUp:
        "None of your citations cover the amount itself. Cite the specific row and field that supports this exact amount.",
    };
  }

  const closeable = gaps.find((g) => CLOSEABLE_GAPS.includes(g.kind)) ?? gaps[0];
  return {
    action: "push_back",
    followUp:
      FOLLOW_UP_TEMPLATES[closeable.kind] ??
      `Gap: ${closeable.description}. Search again and cite a specific row, or confirm it's genuinely missing.`,
  };
}

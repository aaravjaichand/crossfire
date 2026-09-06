// The proposed adjusting journal entry shown with every exception verdict.
//
// This is a fixed table, not a model call. Each gap kind maps to one debit
// account, one credit account, a rule saying where the amount comes from, and
// a one-line memo. The controller sees the entry before choosing a remedy, and
// sees the citations the amount rests on beside it, so the figure is never an
// assertion the screen makes on its own.

import { toCents, usd } from "@/lib/accountant/money";
import type { Citation, GapKind, SampleType } from "./evidence-types";

/**
 * Where the amount comes from.
 *
 * - sample_amount     the sampled row's own amount, taken at its absolute
 *                     value: a journal entry has no sign, the accounts carry
 *                     the direction.
 * - rate_variance     the cited invoice amount less the cited contract rate.
 * - stated_difference the difference the gap itself states. Those descriptions
 *                     are written by src/lib/accountant/gather.ts, not by the
 *                     model, so the figure is deterministic.
 *
 * Every rule falls back to sample_amount when the citations it wants are not
 * on the bundle, so an exception always has an entry to show.
 */
export type AmountRule = "sample_amount" | "rate_variance" | "stated_difference";

export type AdjustmentSpec = {
  debit: string;
  credit: string;
  amountRule: AmountRule;
  /** Reads as the answer to "where does this figure come from?". */
  amountSource: string;
  memo: string;
};

export type ProposedEntry = {
  gapKind: GapKind;
  debit: string;
  credit: string;
  /** Formatted, e.g. "$9,200.00". Always positive. */
  amount: string;
  amountSource: string;
  memo: string;
  /** The citations that justify the amount. May be empty. */
  basis: Citation[];
  /** True when the rule's own citations were missing and it fell back. */
  fellBack: boolean;
};

const SAMPLE_TABLE: Record<SampleType, string> = {
  invoice: "invoices",
  bank_transaction: "bank_transactions",
  dodo_transaction: "dodo_transactions",
};

/**
 * One entry per GapKind in src/lib/accountant/types.ts. Kinds that describe a
 * control failure rather than a measured misstatement reclassify the amount
 * into a holding account rather than pretending to know the correction; that
 * is what a real controller books while the item is unresolved.
 */
export const ADJUSTMENTS: Record<GapKind, AdjustmentSpec> = {
  duplicate_payment: {
    debit: "Accounts receivable — vendor overpayments",
    credit: "Operating expenses",
    amountRule: "sample_amount",
    amountSource: "the duplicated payment",
    memo: "Reverse the second settlement of this reference and set up the refund receivable.",
  },
  rate_mismatch: {
    debit: "Accounts receivable — vendor overpayments",
    credit: "Operating expenses",
    amountRule: "rate_variance",
    amountSource: "the invoice amount less the contracted monthly rate",
    memo: "Reverse the amount billed above the contracted monthly rate.",
  },
  missing_approval: {
    debit: "Unsupported expenditures — under review",
    credit: "Operating expenses",
    amountRule: "sample_amount",
    amountSource: "the unapproved invoice",
    memo: "Reclassify the unapproved disbursement until approval evidence is produced.",
  },
  unknown_counterparty: {
    debit: "Suspense — unidentified counterparty",
    credit: "Operating expenses",
    amountRule: "sample_amount",
    amountSource: "the payment to the unidentified counterparty",
    memo: "Park the payment in suspense until the counterparty is identified.",
  },
  outside_contract_term: {
    debit: "Prepaid expenses",
    credit: "Operating expenses",
    amountRule: "sample_amount",
    amountSource: "the invoice dated outside the contract term",
    memo: "Defer the charge billed outside the contract's effective dates.",
  },
  duplicate_invoice_month: {
    debit: "Accounts payable",
    credit: "Operating expenses",
    amountRule: "sample_amount",
    amountSource: "the second invoice for the service month",
    memo: "Reverse the second invoice recorded for a month already billed.",
  },
  payout_mismatch: {
    debit: "Accounts receivable — Dodo Payments",
    credit: "Payment processing fees",
    amountRule: "stated_difference",
    amountSource: "the difference between the payout and the month's settlement math",
    memo: "Record the unexplained difference between the Dodo payout and payments less refunds less fees.",
  },
  missing_ledger_entry: {
    debit: "Operating expenses",
    credit: "Cash — operating",
    amountRule: "sample_amount",
    amountSource: "the transaction absent from the ledger",
    memo: "Post the journal entry for a transaction that never reached the ledger.",
  },
  no_bank_match: {
    debit: "Operating expenses",
    credit: "Accounts payable",
    amountRule: "sample_amount",
    amountSource: "the invoice with no settlement",
    memo: "Accrue the invoice that has no matching payment in the bank feed.",
  },
  no_matching_invoice: {
    debit: "Unsupported expenditures — under review",
    credit: "Operating expenses",
    amountRule: "sample_amount",
    amountSource: "the payment with no invoice behind it",
    memo: "Reclassify the disbursement that has no supporting invoice.",
  },
  other: {
    debit: "Suspense — audit adjustments",
    credit: "Operating expenses",
    amountRule: "sample_amount",
    amountSource: "the sampled transaction",
    memo: "Park the exception in suspense until the underlying issue is identified.",
  },
};

export type AdjustmentInput = {
  gapKind: GapKind;
  sampleType: SampleType;
  sampleId: number;
  /** audit_samples.amount or the source row's amount, as a numeric string. */
  sampleAmount: string;
  citations: Citation[];
  /** The gap's description, used only by the stated_difference rule. */
  gapDescription?: string;
};

/** Never returns null: every exception gets an entry, falling back to `other`. */
export function proposeAdjustment(input: AdjustmentInput): ProposedEntry {
  const spec = ADJUSTMENTS[input.gapKind] ?? ADJUSTMENTS.other;
  const resolved = resolveAmount(spec.amountRule, input);
  return {
    gapKind: input.gapKind,
    debit: spec.debit,
    credit: spec.credit,
    amount: usd(Math.abs(resolved.cents)),
    amountSource: resolved.fellBack ? ADJUSTMENTS.other.amountSource : spec.amountSource,
    memo: spec.memo,
    basis: resolved.basis,
    fellBack: resolved.fellBack,
  };
}

type Resolved = { cents: number; basis: Citation[]; fellBack: boolean };

function resolveAmount(rule: AmountRule, input: AdjustmentInput): Resolved {
  if (rule === "rate_variance") {
    const invoice = findCitation(input.citations, "invoices", "amount");
    const contract = findCitation(input.citations, "contracts", "monthly_rate");
    if (invoice && contract) {
      const cents = toCents(stripMoney(invoice.value)) - toCents(stripMoney(contract.value));
      if (cents !== 0) return { cents, basis: [invoice, contract], fellBack: false };
    }
    return fallback(input);
  }

  if (rule === "stated_difference") {
    const cents = statedDifference(input.gapDescription);
    if (cents !== null && cents !== 0) {
      return { cents, basis: sampleCitations(input), fellBack: false };
    }
    return fallback(input);
  }

  return { cents: toCents(input.sampleAmount), basis: sampleCitations(input), fellBack: false };
}

function fallback(input: AdjustmentInput): Resolved {
  return { cents: toCents(input.sampleAmount), basis: sampleCitations(input), fellBack: true };
}

/**
 * "a difference of $412.60" / "a difference of -$412.60". The accountant's gap
 * descriptions are template strings from deterministic code, so this reads a
 * figure the app itself wrote rather than model prose.
 */
const STATED = /difference of (-?)\$([\d,]+\.\d{2})/;

function statedDifference(description: string | undefined): number | null {
  if (!description) return null;
  const match = STATED.exec(description);
  if (!match) return null;
  return toCents(`${match[1]}${match[2].replace(/,/g, "")}`);
}

/** The citations that describe the sampled row itself. */
function sampleCitations(input: AdjustmentInput): Citation[] {
  const table = SAMPLE_TABLE[input.sampleType];
  return input.citations.filter((c) => c.table === table && c.id === input.sampleId);
}

function findCitation(citations: Citation[], table: string, field: string): Citation | undefined {
  return citations.find((c) => c.table === table && c.field === field);
}

/** Citation values are already-formatted money as often as raw numerics. */
function stripMoney(value: string): string {
  return value.replace(/[$,\s]/g, "");
}

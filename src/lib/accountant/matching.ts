/**
 * The invoice/bank payment match rule, kept pure so it can be tested against
 * rows that do not exist in the seed (wrong vendor, wrong amount, wrong date).
 *
 * The task spec says a payment matches an invoice "with dates within 7 days".
 * Taken literally against the issue date that window matches nothing: Northwind
 * pays net 30, and the seed settles every invoice 8 to 24 days after issue. The
 * conservative reading, and the one implemented here, keeps the 7-day tolerance
 * but hangs it off the contractual payment window rather than off the issue date
 * alone: a payment is in window when it falls between 7 days before the issue
 * date and 7 days after the net-30 due date, inclusive. That is bounded (it can
 * never reach the next month's invoice for the same vendor, which is issued 30
 * days later and paid 8 to 24 days after that) and it never widens beyond what
 * the contract's payment terms allow.
 *
 * A reference match is a signal, not a licence: a bank line that quotes an
 * invoice number still has to agree on vendor, absolute amount, direction and
 * date before it is treated as settling that invoice. A line that quotes the
 * number but fails one of those tests is reported as its own finding rather
 * than silently attached or silently dropped.
 */
import { addDays } from "./money";

export const MATCHING = {
  /** Tolerance either side of the contractual payment window (issue .. net-30 due). */
  paymentWindowDays: 7,
  /** Cash is reconciled against the bank feed within this many days of the sample. */
  cashScanWindowDays: 3,
  /** Internal policy: invoices above this need a named approver. */
  approvalThresholdCents: 1_000_000,
  /** Unknown counterparties above this are called out as the material case. */
  unknownCounterpartyNotableCents: 500_000,
} as const;

export type PaymentCandidate = {
  invoiceNumber: string;
  invoiceAmountCents: number;
  issueDate: string;
  dueDate: string;
  vendorName: string;
  bankReference: string;
  bankCounterparty: string;
  bankAmountCents: number;
  bankDate: string;
  /** True when the bank line quotes a different invoice's number. */
  referenceClaimedByAnotherInvoice: boolean;
};

export type PaymentLink =
  | { matched: true; via: "reference" | "vendor_amount_window"; quotesInvoice: boolean }
  | { matched: false; reason: RejectionReason; quotesInvoice: boolean };

export type RejectionReason =
  | "not_a_payment"
  | "counterparty"
  | "amount"
  | "outside_window"
  | "claimed_elsewhere"
  | "no_link_signal";

export function paymentWindow(candidate: Pick<PaymentCandidate, "issueDate" | "dueDate">) {
  return {
    from: addDays(candidate.issueDate, -MATCHING.paymentWindowDays),
    to: addDays(candidate.dueDate, MATCHING.paymentWindowDays),
  };
}

/** Decides whether one bank line settles one invoice, and if not, why not. */
export function classifyPaymentLink(candidate: PaymentCandidate): PaymentLink {
  const quotesInvoice = candidate.bankReference === candidate.invoiceNumber;

  if (candidate.bankAmountCents >= 0) {
    return { matched: false, reason: "not_a_payment", quotesInvoice };
  }
  if (candidate.bankCounterparty !== candidate.vendorName) {
    return { matched: false, reason: "counterparty", quotesInvoice };
  }
  if (Math.abs(candidate.bankAmountCents) !== candidate.invoiceAmountCents) {
    return { matched: false, reason: "amount", quotesInvoice };
  }
  const window = paymentWindow(candidate);
  if (candidate.bankDate < window.from || candidate.bankDate > window.to) {
    return { matched: false, reason: "outside_window", quotesInvoice };
  }
  if (quotesInvoice) {
    return { matched: true, via: "reference", quotesInvoice };
  }
  if (candidate.referenceClaimedByAnotherInvoice) {
    return { matched: false, reason: "claimed_elsewhere", quotesInvoice };
  }
  return { matched: true, via: "vendor_amount_window", quotesInvoice };
}

/** One sentence explaining a rejection, for the gap raised on a quoting line. */
export function describeRejection(reason: RejectionReason, candidate: PaymentCandidate): string {
  const window = paymentWindow(candidate);
  switch (reason) {
    case "not_a_payment":
      return "it is a deposit, not a payment";
    case "counterparty":
      return `it pays "${candidate.bankCounterparty}", not the invoice's vendor ${candidate.vendorName}`;
    case "amount":
      return "the amount paid does not equal the invoice amount";
    case "outside_window":
      return `it falls outside the payment window ${window.from} to ${window.to} (issue date less ${MATCHING.paymentWindowDays} days to net-30 due date plus ${MATCHING.paymentWindowDays} days)`;
    case "claimed_elsewhere":
      return "it quotes another invoice's number";
    case "no_link_signal":
      return "nothing links it to this invoice";
  }
}

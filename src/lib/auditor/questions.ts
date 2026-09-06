// Question bank + deterministic template selection. The auditor always asks
// a question drawn from one of these templates; the LLM (llm.ts) only
// rephrases the filled text more naturally, it never invents facts.
import type { SampleDetail } from "./detail";
import { monthYearLabel } from "./detail";
import type { SampleCandidate } from "./sampler";
import { usd } from "./util";

export type SampleType = "bank_transaction" | "invoice" | "dodo_transaction";

/**
 * The substantive audit procedure a question exercises. Persisted on the
 * auditor exchange (audit_exchanges.procedure) so a run can be read as audit
 * work — "which procedures did we perform, and where did they fail" — rather
 * than as a list of one-off questions.
 */
export const PROCEDURES = [
  "three_way_match",
  "cutoff",
  "unrecorded_liabilities",
  "bank_rec",
  "revenue_tie_out",
  "approval_control",
] as const;

export type AuditProcedure = (typeof PROCEDURES)[number];

export type QuestionTemplate = {
  id: string;
  sampleType: SampleType;
  procedure: AuditProcedure;
  text: string; // may contain {placeholders} filled per sample
};

export const QUESTION_TEMPLATES: QuestionTemplate[] = [
  // ---- invoice ----
  {
    id: "show_invoice_approval",
    procedure: "approval_control",
    sampleType: "invoice",
    text: "Show the approval for invoice {invoiceNumber} from {vendorName} for {amount}.",
  },
  {
    id: "show_contract_rate",
    procedure: "three_way_match",
    sampleType: "invoice",
    text: "Show the contract clause authorizing the {amount} rate billed on invoice {invoiceNumber} from {vendorName}.",
  },
  {
    id: "explain_duplicate_invoice_month",
    procedure: "three_way_match",
    sampleType: "invoice",
    text: "Explain why {vendorName} has two invoices in {monthYear}: is invoice {invoiceNumber} for {amount} legitimate or a duplicate?",
  },
  {
    id: "show_invoice_within_contract_term",
    procedure: "cutoff",
    sampleType: "invoice",
    text: "Show that invoice {invoiceNumber} dated {issueDate} from {vendorName} falls within the contract's effective term.",
  },
  {
    id: "show_invoice_bank_match",
    procedure: "bank_rec",
    sampleType: "invoice",
    text: "Show which bank payment settled invoice {invoiceNumber} from {vendorName} for {amount}.",
  },
  // ---- bank_transaction ----
  {
    id: "show_invoice_behind_payment",
    procedure: "three_way_match",
    sampleType: "bank_transaction",
    text: "Show the invoice behind the {amount} payment to {counterparty} on {date} (ref {reference}).",
  },
  {
    id: "explain_duplicate_payment",
    procedure: "bank_rec",
    sampleType: "bank_transaction",
    text: "Explain why there appear to be multiple bank payments referencing {reference} to {counterparty}.",
  },
  {
    id: "show_unknown_counterparty",
    procedure: "approval_control",
    sampleType: "bank_transaction",
    text: "Show who {counterparty} is and why Northwind Labs sent them {amount} on {date} (ref {reference}).",
  },
  {
    id: "show_ledger_entry_for_bank",
    procedure: "unrecorded_liabilities",
    sampleType: "bank_transaction",
    text: "Show the ledger entry recorded for the {amount} transaction with {counterparty} on {date} (ref {reference}).",
  },
  // ---- dodo_transaction ----
  {
    id: "show_ledger_entry_for_refund",
    procedure: "revenue_tie_out",
    sampleType: "dodo_transaction",
    text: "Show the ledger entry for the {amount} refund on {date} (ref {reference}).",
  },
  {
    id: "show_payout_rollup",
    procedure: "revenue_tie_out",
    sampleType: "dodo_transaction",
    text: "Show which payout this {amount} payment on {date} (ref {reference}) rolled into and the fee applied.",
  },
  {
    id: "show_dispute_outcome",
    procedure: "revenue_tie_out",
    sampleType: "dodo_transaction",
    text: "Show how the {amount} dispute on {date} (ref {reference}) was resolved and where that outcome is recorded.",
  },
  {
    id: "show_payout_composition",
    procedure: "revenue_tie_out",
    sampleType: "dodo_transaction",
    text: "Show the composition of payout {reference} for {amount}: payments minus refunds minus fees for that period.",
  },
];

const TEMPLATES_BY_ID = new Map(QUESTION_TEMPLATES.map((t) => [t.id, t]));

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

export type ChosenQuestion = { templateId: string; procedure: AuditProcedure; text: string };

/**
 * Deterministic template choice from plain facts about the sample. No LLM
 * involved: this is the fallback text the LLM is asked to rephrase, and the
 * text actually used if the LLM call fails.
 */
export function chooseQuestion(candidate: SampleCandidate, detail: SampleDetail): ChosenQuestion {
  const amount = usd(Math.abs(candidate.amountCents));

  if (detail.kind === "invoice") {
    let templateId: string;
    if (detail.approvedBy === null) {
      templateId = "show_invoice_approval";
    } else if (detail.hasSiblingInvoiceSameMonth) {
      templateId = "explain_duplicate_invoice_month";
    } else if (detail.outsideContractTerm) {
      templateId = "show_invoice_within_contract_term";
    } else if (detail.contractRateCents !== null && detail.contractRateCents !== detail.amountCents) {
      templateId = "show_contract_rate";
    } else {
      templateId = "show_invoice_bank_match";
    }
    const vars = {
      invoiceNumber: detail.invoiceNumber,
      vendorName: detail.vendorName,
      amount,
      issueDate: detail.issueDate,
      monthYear: monthYearLabel(detail.issueDate),
    };
    return chosen(templateId, vars);
  }

  if (detail.kind === "bank_transaction") {
    let templateId: string;
    if (detail.duplicateReferenceCount > 0) {
      templateId = "explain_duplicate_payment";
    } else if (!detail.isKnownCounterparty && Math.abs(candidate.amountCents) >= 500_000) {
      templateId = "show_unknown_counterparty";
    } else if (detail.isKnownCounterparty && candidate.amountCents < 0) {
      templateId = "show_invoice_behind_payment";
    } else {
      templateId = "show_ledger_entry_for_bank";
    }
    const vars = {
      counterparty: detail.counterparty,
      amount,
      date: detail.date,
      reference: detail.reference,
    };
    return chosen(templateId, vars);
  }

  // dodo_transaction
  let templateId: string;
  if (detail.type === "refund") templateId = "show_ledger_entry_for_refund";
  else if (detail.type === "dispute") templateId = "show_dispute_outcome";
  else if (detail.type === "payout") templateId = "show_payout_composition";
  else templateId = "show_payout_rollup";
  const vars = {
    amount,
    date: detail.date,
    reference: detail.reference,
  };
  return chosen(templateId, vars);
}

function chosen(templateId: string, vars: Record<string, string>): ChosenQuestion {
  const template = TEMPLATES_BY_ID.get(templateId)!;
  return { templateId, procedure: template.procedure, text: fill(template.text, vars) };
}

/** The procedure a stored template id exercises, for reading old rows back. */
export function procedureFor(templateId: string): AuditProcedure | null {
  return TEMPLATES_BY_ID.get(templateId)?.procedure ?? null;
}

import { inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Citation, EvidenceBundle, Gap, SampleRef } from "./evidence-types";
import type { MessageView, RunView, SampleStatus, SampleView } from "./data";
import { bankLabel, dodoLabel, invoiceLabel } from "./labels";
import { formatSampleId } from "./sample-id";

// A hand-written run over real seeded rows, used until an auditor run exists to
// point the screen at. Two invariants hold it together:
//
//   1. Every number on screen is read out of the database at request time. The
//      prose is fixed; the citations are {table, id, field} specs resolved
//      against the live row, so a citation that stops matching the seed throws
//      with the table and id instead of quietly showing a stale figure.
//   2. Every factual sentence carries an inline [table#id] citation naming a
//      row in that turn's bundle, the same invariant the accountant enforces on
//      model prose. referee/citations.check.ts runs the accountant's own
//      validateDefense over all of it.

export const MOCK_RUN_ID = "mock";

type TableName =
  | "vendors"
  | "contracts"
  | "invoices"
  | "bank_transactions"
  | "dodo_transactions"
  | "ledger_entries";

type CitationSpec = { table: TableName; id: number; field: string; reason: string };

export type TurnSpec = {
  role: "auditor" | "accountant";
  content: string;
  /** Rows the prose may cite. Rendered as evidence cards for accountant turns;
   * auditor turns use them only to validate their inline citations. */
  citations: CitationSpec[];
  gaps?: Gap[];
};

export type SampleSpec = { ref: SampleRef; status: SampleStatus; turns: TurnSpec[] };

export const SAMPLES: SampleSpec[] = [
  {
    ref: { type: "invoice", id: 15 },
    status: "gap",
    turns: [
      {
        role: "auditor",
        content:
          "Invoice HPP-2025-03 is booked to Rent for March 2025 [invoices#15]. Walk me from the invoice to the cash that left the account, and show that it left exactly once.",
        citations: [
          { table: "invoices", id: 15, field: "invoice_number", reason: "The invoice under examination." },
        ],
      },
      {
        role: "accountant",
        content:
          "The invoice itself is clean; the cash side is not. Harbor Point Properties LLC billed $9,200.00 on 2025-03-01 [invoices#15], which is exactly the monthly rate on the contract [contracts#2]. The bank feed then settles reference HPP-2025-03 twice, on 2025-03-24 [bank_transactions#72] and again on 2025-03-27 [bank_transactions#73]. Both settlements are booked, so Cash is credited twice [ledger_entries#314, #326] against a single payable. I can defend the first payment and not the second.",
        citations: [
          { table: "invoices", id: 15, field: "amount", reason: "The invoice being settled, priced at the contract rate." },
          { table: "contracts", id: 2, field: "monthly_rate", reason: "Contract rate for Harbor Point rent matches the invoice to the cent." },
          { table: "bank_transactions", id: 72, field: "date", reason: "First settlement of reference HPP-2025-03." },
          { table: "bank_transactions", id: 73, field: "date", reason: "Second settlement of the same reference three days later." },
          { table: "ledger_entries", id: 314, field: "credit", reason: "Cash credited for the first payment." },
          { table: "ledger_entries", id: 326, field: "credit", reason: "Cash credited again for the duplicate payment." },
        ],
        gaps: [
          {
            kind: "duplicate_payment",
            description:
              "Bank rows 72 and 73 both settle HPP-2025-03 for $9,200.00, but only one payable exists. No credit note or vendor refund reverses the second.",
          },
        ],
      },
    ],
  },
  {
    ref: { type: "invoice", id: 5 },
    status: "gap",
    turns: [
      {
        role: "auditor",
        content:
          "Invoice STR-2025-05 bills $21,275.00 [invoices#5], more than any other Stratus invoice this year. Show me the pricing authority for that amount.",
        citations: [
          { table: "invoices", id: 5, field: "amount", reason: "The invoice under examination." },
        ],
      },
      {
        role: "accountant",
        content:
          "There is none on file. The contract fixes the Stratus monthly rate at $18,500.00 for all of 2025 [contracts#1], and the January invoice bills exactly that [invoices#1]. This one bills $21,275.00 [invoices#5], fifteen percent over the rate, and it was approved as issued [invoices#5]. The bank settled the billed amount rather than the contracted one on 2025-05-17 [bank_transactions#109], and the expense was recognised at the higher figure [ledger_entries#457]. No amendment or credit note supports the $2,775.00 difference [contracts#1, invoices#5].",
        citations: [
          { table: "contracts", id: 1, field: "monthly_rate", reason: "The contracted monthly rate the invoice should have billed." },
          { table: "invoices", id: 5, field: "amount", reason: "The amount actually billed, 15% above the contract rate." },
          { table: "invoices", id: 1, field: "amount", reason: "A sibling Stratus invoice billed at the contract rate, showing the norm." },
          { table: "invoices", id: 5, field: "approved_by", reason: "The overbilled amount was approved as issued." },
          { table: "bank_transactions", id: 109, field: "amount", reason: "The bank settled the billed amount, not the contract amount." },
          { table: "ledger_entries", id: 457, field: "debit", reason: "Cloud Infrastructure was expensed at the overbilled amount." },
        ],
        gaps: [
          {
            kind: "rate_mismatch",
            description: "Invoice 5 exceeds contract 1's monthly rate by $2,775.00 with no amendment on file.",
          },
        ],
      },
    ],
  },
  {
    ref: { type: "bank_transaction", id: 202 },
    status: "gap",
    turns: [
      {
        role: "auditor",
        content:
          "A wire for $7,850.00 left the account on 2025-09-12 [bank_transactions#202]. Who is Kestrel Holdings Ltd [bank_transactions#202], and what authorised the payment?",
        citations: [
          { table: "bank_transactions", id: 202, field: "counterparty", reason: "The payee on the wire under examination." },
        ],
      },
      {
        role: "accountant",
        content:
          "I cannot place them. The payee on the wire is Kestrel Holdings Ltd [bank_transactions#202], and no vendor row carries that name. There is no invoice or contract naming them either, so the reference WIRE-20250912-4471 is the only support the payment has [bank_transactions#202]. It was booked straight to Consulting Expense [ledger_entries#1025] against Cash [ledger_entries#1026], with no document behind the classification.",
        citations: [
          { table: "bank_transactions", id: 202, field: "counterparty", reason: "The payee has no matching row in vendors." },
          { table: "bank_transactions", id: 202, field: "amount", reason: "The amount leaving the account, above the $5,000 wire threshold." },
          { table: "ledger_entries", id: 1025, field: "account", reason: "The expense account the wire was booked to without a supporting document." },
          { table: "ledger_entries", id: 1026, field: "credit", reason: "Cash credited for the full wire amount." },
        ],
        gaps: [
          {
            kind: "unknown_counterparty",
            description:
              "Kestrel Holdings Ltd is not a vendor, payroll recipient, or processor, and no document supports the Consulting Expense classification.",
          },
          {
            kind: "no_matching_invoice",
            description: "No invoice, contract, or statement of work references WIRE-20250912-4471.",
          },
        ],
      },
    ],
  },
  {
    ref: { type: "dodo_transaction", id: 92 },
    status: "gap",
    turns: [
      {
        role: "auditor",
        content:
          "A refund of $499.00 was processed on 2025-04-12 [dodo_transactions#92]. Show me the journal entry that reverses the revenue.",
        citations: [
          { table: "dodo_transactions", id: 92, field: "amount", reason: "The refund under examination." },
        ],
      },
      {
        role: "accountant",
        content:
          "There is no such entry. The original payment for $499.00 on 2025-04-01 [dodo_transactions#82] is booked correctly, debiting Dodo Clearing [ledger_entries#355] and crediting Revenue [ledger_entries#356]. The refund of the same amount [dodo_transactions#92] has no ledger row of its own, so April revenue is overstated. The April payout had already deducted the refund, which is why Dodo Clearing does not net to zero for that month [dodo_transactions#92].",
        citations: [
          { table: "dodo_transactions", id: 92, field: "amount", reason: "The refund amount that never reached the ledger." },
          { table: "dodo_transactions", id: 82, field: "reference", reason: "The original payment the refund reverses." },
          { table: "ledger_entries", id: 355, field: "debit", reason: "Dodo Clearing debited when the payment came in." },
          { table: "ledger_entries", id: 356, field: "credit", reason: "Revenue credited for a payment that was later refunded." },
        ],
        gaps: [
          {
            kind: "missing_ledger_entry",
            description: "No ledger row carries source_type dodo and source_id 92, so the $499.00 refund is unbooked.",
          },
        ],
      },
    ],
  },
  {
    ref: { type: "bank_transaction", id: 133 },
    status: "open",
    turns: [
      {
        role: "auditor",
        content:
          "A payment of $3,120.00 went out on 2025-06-20 under reference ACH-20250620-BHI [bank_transactions#133]. Which invoice does it settle?",
        citations: [
          { table: "bank_transactions", id: 133, field: "reference", reason: "The payment under examination." },
        ],
      },
      {
        role: "accountant",
        content:
          "None that I can find. The payee is a known vendor [vendors#5], so this is not an unknown counterparty. Its contract bills $2,350.00 a month [contracts#5], which does not match the amount paid [bank_transactions#133]. The payment was still debited to Accounts Payable [ledger_entries#653] with Cash credited [ledger_entries#654], so it cleared a payable that no invoice created.",
        citations: [
          { table: "bank_transactions", id: 133, field: "amount", reason: "The payment with no invoice behind it." },
          { table: "vendors", id: 5, field: "name", reason: "The payee is a known vendor, which rules out an unknown counterparty." },
          { table: "contracts", id: 5, field: "monthly_rate", reason: "The contracted monthly amount does not match the payment either." },
          { table: "ledger_entries", id: 653, field: "debit", reason: "Accounts Payable debited without an originating invoice." },
          { table: "ledger_entries", id: 654, field: "credit", reason: "Cash credited for the full payment." },
        ],
        gaps: [
          {
            kind: "no_matching_invoice",
            description:
              "No invoice from vendor 5 matches $3,120.00 or reference ACH-20250620-BHI, yet the payment cleared Accounts Payable.",
          },
        ],
      },
      {
        role: "auditor",
        content:
          "Insurance is often billed annually rather than monthly. Is the amount a multiple of the contracted monthly rate, or a premium adjustment [contracts#5]?",
        citations: [
          { table: "contracts", id: 5, field: "monthly_rate", reason: "The contracted rate the payment is being tested against." },
        ],
      },
      {
        role: "accountant",
        content:
          "Neither. The payment is not a whole multiple of the $2,350.00 monthly rate [contracts#5, bank_transactions#133]. The contract terms on file carry no premium adjustment clause [contracts#5], and the contract is still in force on the payment date [contracts#5], so a lapse does not explain it either. Every other payment to this vendor in the feed references an invoice number; this one references an ACH batch the vendor never issued [bank_transactions#133].",
        citations: [
          { table: "contracts", id: 5, field: "terms_text", reason: "The contract terms as filed, with no premium adjustment provision." },
          { table: "contracts", id: 5, field: "effective_to", reason: "The contract is in force on the payment date, so lapse does not explain it." },
          { table: "bank_transactions", id: 133, field: "reference", reason: "The reference is an ACH batch id, not an invoice number." },
        ],
        gaps: [
          {
            kind: "no_matching_invoice",
            description:
              "The amount reconciles to no combination of contract 5's monthly rate, so the payment remains unsupported.",
          },
        ],
      },
    ],
  },
  {
    ref: { type: "invoice", id: 33 },
    status: "open",
    turns: [
      {
        role: "auditor",
        content:
          "Notchwork billed twice in August 2025, first NWK-2025-08 [invoices#32] and then NWK-2025-08B [invoices#33]. Justify the second one.",
        citations: [
          { table: "invoices", id: 32, field: "invoice_number", reason: "The first August invoice." },
          { table: "invoices", id: 33, field: "invoice_number", reason: "The second August invoice, under examination." },
        ],
      },
      {
        role: "accountant",
        content:
          "I can show the paperwork but not the entitlement. The contract is a $1,450.00 monthly subscription [contracts#3], and NWK-2025-08 already covers August at that amount [invoices#32]. The second invoice is dated 2025-08-18 for the same amount [invoices#33] and was approved by Marcus Webb [invoices#33]. It was paid in full on 2025-09-03 [bank_transactions#196] and expensed to Software Subscriptions a second time for the month [ledger_entries#923]. The contract provides for one monthly charge [contracts#3], so unless there is an upgrade order outside the system, August was billed twice.",
        citations: [
          { table: "contracts", id: 3, field: "monthly_rate", reason: "A single monthly charge is all the contract provides for." },
          { table: "invoices", id: 32, field: "invoice_number", reason: "The first August invoice, which already covers the month." },
          { table: "invoices", id: 33, field: "issue_date", reason: "The second August invoice, issued mid-month." },
          { table: "invoices", id: 33, field: "approved_by", reason: "The duplicate month was approved as issued." },
          { table: "bank_transactions", id: 196, field: "amount", reason: "The second invoice was paid in full." },
          { table: "ledger_entries", id: 923, field: "debit", reason: "Software Subscriptions expensed twice for August." },
        ],
        gaps: [
          {
            kind: "duplicate_invoice_month",
            description:
              "Vendor 3 issued two invoices covering August 2025 under a contract that provides for one monthly charge.",
          },
        ],
      },
    ],
  },
  {
    ref: { type: "dodo_transaction", id: 340 },
    status: "open",
    turns: [
      {
        role: "auditor",
        content:
          "The October payout came to $3,558.80 [dodo_transactions#340], and October is the only month where the clearing account does not net to zero. Explain the difference.",
        citations: [
          { table: "dodo_transactions", id: 340, field: "amount", reason: "The payout under examination." },
        ],
      },
      {
        role: "accountant",
        content:
          "The payout is right and the books are wrong. Payments less refunds less fees for October come to $3,657.80, but Dodo paid out $3,558.80 [dodo_transactions#340] and the bank received exactly that [bank_transactions#241]. The $99.00 difference is a dispute Dodo records as lost [dodo_transactions#317], raised against a payment taken earlier in the month [dodo_transactions#317]. No ledger row carries that dispute, so clearing was reduced only by the payout received [ledger_entries#1254] and is overstated by the disputed amount.",
        citations: [
          { table: "dodo_transactions", id: 340, field: "amount", reason: "The payout Dodo actually made for October." },
          { table: "bank_transactions", id: 241, field: "amount", reason: "The bank confirms the payout amount, so the shortfall is not a timing difference." },
          { table: "dodo_transactions", id: 317, field: "reference", reason: "The lost dispute that accounts for the entire difference." },
          { table: "dodo_transactions", id: 317, field: "amount", reason: "The dispute amount equals the payout shortfall to the cent." },
          { table: "ledger_entries", id: 1254, field: "credit", reason: "Dodo Clearing cleared only by the received payout, leaving the dispute stranded." },
        ],
        gaps: [
          {
            kind: "payout_mismatch",
            description: "Expected payout of $3,657.80 versus actual $3,558.80 for October 2025.",
          },
          {
            kind: "missing_ledger_entry",
            description: "No ledger row carries source_type dodo and source_id 317, the lost dispute.",
          },
        ],
      },
    ],
  },
  {
    ref: { type: "invoice", id: 9 },
    status: "conceded",
    turns: [
      {
        role: "auditor",
        content:
          "STR-2025-09 is an $18,500.00 invoice [invoices#9] and it was settled on 2025-09-20 [bank_transactions#209]. Who approved it?",
        citations: [
          { table: "invoices", id: 9, field: "amount", reason: "The invoice under examination." },
          { table: "bank_transactions", id: 209, field: "date", reason: "The settlement the question asserts." },
        ],
      },
      {
        role: "accountant",
        content:
          "Nobody did. The approval field on the invoice is empty [invoices#9], and this is the only invoice above the $10,000 threshold in the year without an approver [invoices#9]. The amount is at the contract rate [contracts#1], so the pricing is not in question. The expense was recognised anyway, debiting Cloud Infrastructure [ledger_entries#979] against Accounts Payable [ledger_entries#980], and the bank settled it in full [bank_transactions#209]. I cannot produce an approval that does not exist.",
        citations: [
          { table: "invoices", id: 9, field: "approved_by", reason: "The approval field is empty on an invoice above the approval threshold." },
          { table: "invoices", id: 9, field: "amount", reason: "The amount is above the $10,000 approval threshold." },
          { table: "contracts", id: 1, field: "monthly_rate", reason: "The amount is at the contract rate, so only the approval is missing." },
          { table: "bank_transactions", id: 209, field: "amount", reason: "The unapproved invoice was paid in full." },
          { table: "ledger_entries", id: 979, field: "debit", reason: "The expense was recognised despite the missing approval." },
          { table: "ledger_entries", id: 980, field: "credit", reason: "Accounts Payable credited for the unapproved invoice." },
        ],
        gaps: [
          {
            kind: "missing_approval",
            description: "Invoice 9 is above the approval threshold and carries no approver.",
          },
        ],
      },
    ],
  },
  {
    ref: { type: "invoice", id: 49 },
    status: "conceded",
    turns: [
      {
        role: "auditor",
        content:
          "MDC-2025-12 is dated 2025-12-01 [invoices#49], after the Meridian contract ends [contracts#4], and it was paid on 2025-12-15 [bank_transactions#287]. On what authority?",
        citations: [
          { table: "invoices", id: 49, field: "issue_date", reason: "The invoice under examination." },
          { table: "contracts", id: 4, field: "effective_to", reason: "The contract term the invoice falls outside of." },
          { table: "bank_transactions", id: 287, field: "date", reason: "The settlement the question asserts." },
        ],
      },
      {
        role: "accountant",
        content:
          "None that I can cite. The contract runs to 2025-11-30 [contracts#4] and there is no renewal on file. The invoice is issued 2025-12-01 for $6,800.00 [invoices#49], one day outside the term, and it was approved by Priya Natarajan [invoices#49]. It was paid in full on 2025-12-15 [bank_transactions#287] and booked to Contractors [ledger_entries#1423] against Accounts Payable [ledger_entries#1424]. The work may well have happened; the billing has no agreement behind it.",
        citations: [
          { table: "contracts", id: 4, field: "effective_to", reason: "The contract term ends the day before the invoice was issued." },
          { table: "invoices", id: 49, field: "issue_date", reason: "The invoice date falls outside the contract term." },
          { table: "invoices", id: 49, field: "amount", reason: "The amount billed outside the term." },
          { table: "invoices", id: 49, field: "approved_by", reason: "The out-of-term invoice was approved." },
          { table: "bank_transactions", id: 287, field: "amount", reason: "The out-of-term invoice was also paid in full." },
          { table: "ledger_entries", id: 1423, field: "debit", reason: "Contractors expensed for a period the contract does not cover." },
          { table: "ledger_entries", id: 1424, field: "credit", reason: "Accounts Payable credited for the out-of-term invoice." },
        ],
        gaps: [
          {
            kind: "outside_contract_term",
            description: "Invoice 49 is issued after contract 4's effective_to date with no renewal on file.",
          },
        ],
      },
    ],
  },
  {
    ref: { type: "invoice", id: 1 },
    status: "defended",
    turns: [
      {
        role: "auditor",
        content:
          "STR-2025-01 is the largest single expense in January 2025 [invoices#1]. Show contract authority, approval, and settlement.",
        citations: [
          { table: "invoices", id: 1, field: "amount", reason: "The invoice under examination." },
        ],
      },
      {
        role: "accountant",
        content:
          "All three are on file. The contract sets the monthly rate at $18,500.00 from 2025-01-01 through 2025-12-31 [contracts#1], and the invoice bills exactly that on its issue date [invoices#1]. Priya Natarajan approved it [invoices#1]. The bank settled reference STR-2025-01 once, on 2025-01-24, for the same amount [bank_transactions#20]. The journal balances, with the expense debited on issue [ledger_entries#1] and Cash credited on settlement [ledger_entries#86].",
        citations: [
          { table: "contracts", id: 1, field: "monthly_rate", reason: "The contracted rate the invoice bills." },
          { table: "contracts", id: 1, field: "effective_to", reason: "The invoice date falls inside the contract term." },
          { table: "invoices", id: 1, field: "amount", reason: "The billed amount equals the contract rate exactly." },
          { table: "invoices", id: 1, field: "approved_by", reason: "The invoice carries a named approver." },
          { table: "bank_transactions", id: 20, field: "amount", reason: "A single settlement for the full invoice amount." },
          { table: "ledger_entries", id: 1, field: "debit", reason: "Expense recognised on the invoice date." },
          { table: "ledger_entries", id: 86, field: "credit", reason: "Cash credited once on settlement." },
        ],
      },
    ],
  },
  {
    ref: { type: "invoice", id: 20 },
    status: "defended",
    turns: [
      {
        role: "auditor",
        content:
          "August rent came to $9,200.00 [invoices#20]. Prove it was owed and that it was paid once.",
        citations: [
          { table: "invoices", id: 20, field: "amount", reason: "The invoice under examination." },
        ],
      },
      {
        role: "accountant",
        content:
          "The contract fixes rent at $9,200.00 a month through 2025-12-31 [contracts#2], and HPP-2025-08 bills exactly that on 2025-08-01 [invoices#20]. Elena Fischer approved it [invoices#20]. The bank settled it once, on 2025-08-10 [bank_transactions#175]. Rent was debited on issue [ledger_entries#837] and Cash credited on settlement [ledger_entries#886], the same amount on both sides.",
        citations: [
          { table: "contracts", id: 2, field: "monthly_rate", reason: "The contracted rent amount." },
          { table: "invoices", id: 20, field: "amount", reason: "The invoice bills the contract rate." },
          { table: "invoices", id: 20, field: "approved_by", reason: "The invoice carries a named approver." },
          { table: "bank_transactions", id: 175, field: "amount", reason: "One settlement for the full amount." },
          { table: "ledger_entries", id: 837, field: "debit", reason: "Rent expense recognised on the invoice date." },
          { table: "ledger_entries", id: 886, field: "credit", reason: "Cash credited on settlement." },
        ],
      },
    ],
  },
  {
    ref: { type: "invoice", id: 41 },
    status: "defended",
    turns: [
      {
        role: "auditor",
        content:
          "The Meridian contract expires before the year ends [contracts#4]. Confirm MDC-2025-04 is inside the term, approved, and paid once [invoices#41].",
        citations: [
          { table: "contracts", id: 4, field: "effective_to", reason: "The contract term the invoice is tested against." },
          { table: "invoices", id: 41, field: "invoice_number", reason: "The invoice under examination." },
        ],
      },
      {
        role: "accountant",
        content:
          "It is all three. The contract runs 2025-01-01 to 2025-11-30 [contracts#4], so an issue date of 2025-04-01 is inside the term [invoices#41]. The $6,800.00 billed equals the contract monthly rate [contracts#4]. Priya Natarajan approved it [invoices#41]. The bank settled it once, on 2025-04-18 [bank_transactions#91], and the debit and credit match [ledger_entries#351, #412].",
        citations: [
          { table: "contracts", id: 4, field: "effective_from", reason: "The contract is in force before the invoice date." },
          { table: "contracts", id: 4, field: "effective_to", reason: "The contract is still in force on the invoice date." },
          { table: "invoices", id: 41, field: "amount", reason: "The invoice bills the contract monthly rate." },
          { table: "invoices", id: 41, field: "approved_by", reason: "The invoice carries a named approver." },
          { table: "bank_transactions", id: 91, field: "amount", reason: "A single settlement for the full amount." },
          { table: "ledger_entries", id: 351, field: "debit", reason: "Contractors expense recognised on the invoice date." },
          { table: "ledger_entries", id: 412, field: "credit", reason: "Cash credited once on settlement." },
        ],
      },
    ],
  },
  {
    ref: { type: "bank_transaction", id: 20 },
    status: "defended",
    turns: [
      {
        role: "auditor",
        content:
          "A payment of $18,500.00 left the account on 2025-01-24 [bank_transactions#20]. Tie it to a document.",
        citations: [
          { table: "bank_transactions", id: 20, field: "amount", reason: "The payment under examination." },
        ],
      },
      {
        role: "accountant",
        content:
          "The reference on the payment is the invoice number it settles [bank_transactions#20]. That invoice is STR-2025-01 [invoices#1], for the same $18,500.00 [invoices#1], approved by Priya Natarajan [invoices#1]. The payment clears the payable rather than creating an expense, so Accounts Payable is debited [ledger_entries#85] and Cash credited [ledger_entries#86] on the same date.",
        citations: [
          { table: "bank_transactions", id: 20, field: "reference", reason: "The payment reference is the invoice number it settles." },
          { table: "invoices", id: 1, field: "invoice_number", reason: "The invoice named by the payment reference." },
          { table: "invoices", id: 1, field: "amount", reason: "The invoice amount equals the payment exactly." },
          { table: "ledger_entries", id: 85, field: "debit", reason: "Accounts Payable cleared by the payment." },
          { table: "ledger_entries", id: 86, field: "credit", reason: "Cash credited once for the payment." },
        ],
      },
    ],
  },
  {
    ref: { type: "dodo_transaction", id: 81 },
    status: "defended",
    turns: [
      {
        role: "auditor",
        content:
          "Reconcile the March payout to the bank and to the clearing account [dodo_transactions#81].",
        citations: [
          { table: "dodo_transactions", id: 81, field: "reference", reason: "The payout under examination." },
        ],
      },
      {
        role: "accountant",
        content:
          "March reconciles exactly. Dodo paid out $3,051.84 on 2025-03-31 [dodo_transactions#81] and the bank received the same amount that day [bank_transactions#75]. The month's processing fees of $144.16 are booked against clearing [ledger_entries#343]. The payout then clears the balance, with Cash debited [ledger_entries#335] and Dodo Clearing credited [ledger_entries#336] for the same figure.",
        citations: [
          { table: "dodo_transactions", id: 81, field: "amount", reason: "The payout amount Dodo reports." },
          { table: "bank_transactions", id: 75, field: "amount", reason: "The bank received the payout amount unchanged." },
          { table: "ledger_entries", id: 343, field: "debit", reason: "Processing fees for the month booked against clearing." },
          { table: "ledger_entries", id: 335, field: "debit", reason: "Cash debited for the payout." },
          { table: "ledger_entries", id: 336, field: "credit", reason: "Dodo Clearing credited so the month nets to zero." },
        ],
      },
    ],
  },
];

/** The sample ids this run contains, for server-side validation of decisions. */
export function mockSampleIds(): Set<string> {
  return new Set(SAMPLES.map((s) => formatSampleId(s.ref)));
}

type Row = Record<string, string>;
export type Tables = Record<TableName, Map<number, Row>>;

export async function buildMockRun(runId: string = MOCK_RUN_ID): Promise<RunView> {
  const tables = await loadRows();
  const samples = SAMPLES.map((spec) => buildSample(spec, tables));
  return {
    id: runId,
    name: "Northwind Labs FY2025 — walkthrough sample",
    kind: "mock",
    samples,
  };
}

/** The resolved bundle for one turn, used by the citation check as well as the UI. */
export function turnBundle(spec: SampleSpec, turn: TurnSpec, tables: Tables): EvidenceBundle {
  return {
    sample: spec.ref,
    citations: turn.citations.map((c) => resolve(c, tables)),
    gaps: turn.gaps ?? [],
  };
}

export async function loadMockTables(): Promise<Tables> {
  return loadRows();
}

function buildSample(spec: SampleSpec, tables: Tables): SampleView {
  const id = formatSampleId(spec.ref);
  const source = sourceRow(spec.ref, tables);
  const thread: MessageView[] = spec.turns.map((turn, i) => {
    const message: MessageView = { turn: i + 1, role: turn.role, content: turn.content };
    // Only accountant turns carry evidence, matching how the auditor persists
    // real exchanges: its questions cite inline and leave the column null.
    if (turn.role === "accountant") {
      message.evidence = { ...turnBundle(spec, turn, tables), defense: turn.content };
    }
    return message;
  });
  return {
    id,
    type: spec.ref.type,
    label: label(spec.ref, source, tables),
    amount: source.amount,
    date: spec.ref.type === "invoice" ? source.issue_date : source.date,
    status: spec.status,
    thread,
  };
}

function label(ref: SampleRef, source: Row, tables: Tables): string {
  if (ref.type === "invoice") {
    const vendor = tables.vendors.get(Number(source.vendor_id));
    return invoiceLabel(vendor?.name ?? `vendor #${source.vendor_id}`, source.invoice_number);
  }
  if (ref.type === "bank_transaction") return bankLabel(source.counterparty, source.reference);
  return dodoLabel(source.type, source.reference);
}

function sourceRow(ref: SampleRef, tables: Tables): Row {
  const row = tables[sourceTable(ref)].get(ref.id);
  if (!row) {
    throw new Error(`Mock run references ${sourceTable(ref)} row ${ref.id}, which is not in the database.`);
  }
  return row;
}

function resolve(spec: CitationSpec, tables: Tables): Citation {
  const row = tables[spec.table].get(spec.id);
  if (!row) {
    throw new Error(`Mock run cites ${spec.table} row ${spec.id}, which is not in the database.`);
  }
  const value = row[spec.field];
  if (value === undefined) {
    throw new Error(`Mock run cites ${spec.table}.${spec.field}, which is not a column.`);
  }
  const citation: Citation = {
    table: spec.table,
    id: spec.id,
    field: spec.field,
    value,
    reason: spec.reason,
  };
  if (row.file_path) citation.filePath = row.file_path;
  return citation;
}

function idsFor(table: TableName): number[] {
  const ids = new Set<number>();
  for (const sample of SAMPLES) {
    if (sourceTable(sample.ref) === table) ids.add(sample.ref.id);
    for (const turn of sample.turns) {
      for (const c of turn.citations) if (c.table === table) ids.add(c.id);
    }
  }
  return [...ids];
}

function sourceTable(ref: SampleRef): TableName {
  if (ref.type === "invoice") return "invoices";
  if (ref.type === "bank_transaction") return "bank_transactions";
  return "dodo_transactions";
}

async function loadRows(): Promise<Tables> {
  const vendorIds = idsFor("vendors");
  const contractIds = idsFor("contracts");
  const invoiceIds = idsFor("invoices");
  const bankIds = idsFor("bank_transactions");
  const dodoIds = idsFor("dodo_transactions");
  const ledgerIds = idsFor("ledger_entries");

  const [invoices, contracts, banks, dodos, ledgers] = await Promise.all([
    invoiceIds.length
      ? db.select().from(schema.invoices).where(inArray(schema.invoices.id, invoiceIds))
      : [],
    contractIds.length
      ? db.select().from(schema.contracts).where(inArray(schema.contracts.id, contractIds))
      : [],
    bankIds.length
      ? db.select().from(schema.bankTransactions).where(inArray(schema.bankTransactions.id, bankIds))
      : [],
    dodoIds.length
      ? db.select().from(schema.dodoTransactions).where(inArray(schema.dodoTransactions.id, dodoIds))
      : [],
    ledgerIds.length
      ? db.select().from(schema.ledgerEntries).where(inArray(schema.ledgerEntries.id, ledgerIds))
      : [],
  ]);

  // Invoice rows carry the vendor id, so the vendor set is only fully known
  // after the invoices are loaded.
  const wantedVendors = new Set<number>(vendorIds);
  for (const inv of invoices) wantedVendors.add(inv.vendorId);
  const vendors = wantedVendors.size
    ? await db.select().from(schema.vendors).where(inArray(schema.vendors.id, [...wantedVendors]))
    : [];

  return {
    vendors: index(vendors, (r) => ({
      id: String(r.id),
      name: r.name,
      contract_id: r.contractId === null ? "" : String(r.contractId),
    })),
    contracts: index(contracts, (r) => ({
      id: String(r.id),
      vendor_id: String(r.vendorId),
      file_path: r.filePath,
      monthly_rate: r.monthlyRate,
      effective_from: r.effectiveFrom,
      effective_to: r.effectiveTo,
      terms_text: r.termsText,
    })),
    invoices: index(invoices, (r) => ({
      id: String(r.id),
      vendor_id: String(r.vendorId),
      invoice_number: r.invoiceNumber,
      issue_date: r.issueDate,
      due_date: r.dueDate,
      amount: r.amount,
      status: r.status,
      approved_by: r.approvedBy ?? "",
      file_path: r.filePath,
    })),
    bank_transactions: index(banks, (r) => ({
      id: String(r.id),
      date: r.date,
      description: r.description,
      amount: r.amount,
      counterparty: r.counterparty,
      reference: r.reference,
    })),
    dodo_transactions: index(dodos, (r) => ({
      id: String(r.id),
      type: r.type,
      date: r.date,
      amount: r.amount,
      customer_id: r.customerId ?? "",
      reference: r.reference,
    })),
    ledger_entries: index(ledgers, (r) => ({
      id: String(r.id),
      date: r.date,
      account: r.account,
      debit: r.debit,
      credit: r.credit,
      memo: r.memo,
      source_type: r.sourceType,
      source_id: r.sourceId === null ? "" : String(r.sourceId),
    })),
  };
}

function index<T extends { id: number }>(rows: T[], toRow: (row: T) => Row): Map<number, Row> {
  return new Map(rows.map((r) => [r.id, toRow(r)]));
}

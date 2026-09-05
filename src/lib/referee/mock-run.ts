import { inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Citation, Gap, SampleRef } from "./evidence-types";
import type { MessageView, RunView, SampleStatus, SampleView } from "./data";
import { formatSampleId } from "./sample-id";

// A hand-written run over real seeded rows. The prose is fixed; every number in
// the evidence panel is read out of the database at request time, so a citation
// that stops matching the seed fails loudly instead of drifting.

type TableName =
  | "vendors"
  | "contracts"
  | "invoices"
  | "bank_transactions"
  | "dodo_transactions"
  | "ledger_entries";

type CitationSpec = { table: TableName; id: number; field: string; reason: string };

type TurnSpec =
  | { role: "auditor"; content: string }
  | { role: "accountant"; content: string; citations: CitationSpec[]; gaps: Gap[] };

type SampleSpec = { ref: SampleRef; status: SampleStatus; turns: TurnSpec[] };

const SAMPLES: SampleSpec[] = [
  {
    ref: { type: "invoice", id: 15 },
    status: "gap",
    turns: [
      {
        role: "auditor",
        content:
          "Invoice HPP-2025-03 is booked to Rent for March. Walk me from the invoice to the cash that left the account, and show that it left exactly once.",
      },
      {
        role: "accountant",
        content:
          "The invoice itself is clean; the cash side is not. Harbor Point Properties LLC billed $9,200.00 on 2025-03-01, which is exactly the monthly rate on contract 2. The bank feed then settles reference HPP-2025-03 twice, on 2025-03-24 and again on 2025-03-27, for $9,200.00 each, and both settlements are booked. Cash is credited $18,400.00 against a payable of $9,200.00. I can defend the first payment and not the second.",
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
          "STR-2025-05 is $2,775.00 above every other Stratus invoice this year. Show me the pricing authority for that amount.",
      },
      {
        role: "accountant",
        content:
          "There isn't one. Contract 1 fixes the Stratus monthly rate at $18,500.00 for the whole of 2025, and every other Stratus invoice bills exactly that. STR-2025-05 bills $21,275.00, fifteen percent over the rate. It was approved by Priya Natarajan and paid in full on 2025-05-17. I can find no amendment, change order, or credit that supports the excess.",
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
            description:
              "Invoice 5 exceeds contract 1's monthly rate by $2,775.00 with no amendment on file.",
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
          "A $7,850.00 wire left the account on 2025-09-12. Who is Kestrel Holdings Ltd, and what authorised the payment?",
      },
      {
        role: "accountant",
        content:
          "I cannot place them. Kestrel Holdings Ltd is not in the vendor table, is not a payroll counterparty, and is not Dodo. No invoice or contract names them. The only support for the payment is the wire itself, reference WIRE-20250912-4471, and it was booked straight to Consulting Expense with nothing behind the classification.",
        citations: [
          { table: "bank_transactions", id: 202, field: "counterparty", reason: "The payee has no matching row in vendors." },
          { table: "bank_transactions", id: 202, field: "amount", reason: "The amount leaving the account, above the $5,000 wire threshold." },
          { table: "bank_transactions", id: 202, field: "reference", reason: "The only reference on the payment; it appears nowhere else in the books." },
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
          "Refund ref_nx3ulzfvg9d7 on 2025-04-12. Show me the journal entry that reverses the revenue.",
      },
      {
        role: "accountant",
        content:
          "There is no such entry. The original payment pay_v5wed4ozzxvkyo for $499.00 on 2025-04-01 is booked correctly, debiting Dodo Clearing and crediting Revenue. The refund of the same $499.00 has no ledger row at all, while the April payout already deducted it. April revenue is overstated by the refund amount and Dodo Clearing does not net to zero for the month.",
        citations: [
          { table: "dodo_transactions", id: 92, field: "amount", reason: "The refund amount that never reached the ledger." },
          { table: "dodo_transactions", id: 82, field: "reference", reason: "The original payment the refund reverses." },
          { table: "ledger_entries", id: 355, field: "debit", reason: "Dodo Clearing debited when the payment came in." },
          { table: "ledger_entries", id: 356, field: "credit", reason: "Revenue credited for a payment that was later refunded." },
        ],
        gaps: [
          {
            kind: "missing_ledger_entry",
            description:
              "No ledger row carries source_type dodo and source_id 92, so the $499.00 refund is unbooked.",
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
          "ACH-20250620-BHI, $3,120.00 to Bellhaven Insurance Group on 2025-06-20. Which invoice does it settle?",
      },
      {
        role: "accountant",
        content:
          "None that I can find. Bellhaven is vendor 5 and its contract bills $2,350.00 a month, so the amount does not match a monthly invoice either. The payment is still debited to Accounts Payable, which means it reduces a payable that no invoice ever created.",
        citations: [
          { table: "bank_transactions", id: 133, field: "amount", reason: "The payment with no invoice behind it." },
          { table: "bank_transactions", id: 133, field: "reference", reason: "The reference does not match any invoice number." },
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
          "Insurance is often billed annually. Is $3,120.00 a multiple or fraction of the monthly rate, or a premium adjustment?",
      },
      {
        role: "accountant",
        content:
          "Neither cleanly. $3,120.00 is not a whole multiple of the $2,350.00 monthly rate, and the contract holds no premium adjustment clause I can cite. Every other Bellhaven payment in the feed carries an invoice reference; this one carries an ACH reference the vendor never issued.",
        citations: [
          { table: "contracts", id: 5, field: "terms_text", reason: "The contract terms as filed, with no premium adjustment provision." },
          { table: "contracts", id: 5, field: "effective_to", reason: "The contract is in force on the payment date, so lapse does not explain it." },
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
        content: "Notchwork billed twice in August. Justify NWK-2025-08B.",
      },
      {
        role: "accountant",
        content:
          "I can show the paperwork but not the entitlement. Contract 3 is a $1,450.00 monthly subscription and NWK-2025-08 already covers August at that amount. NWK-2025-08B is dated 2025-08-18 for the same $1,450.00, was approved by Marcus Webb, and was paid on 2025-09-03. The contract has no clause for a second monthly charge, so unless there is an upgrade order outside the system, August was billed twice.",
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
          "October is the only month where Dodo Clearing does not net to zero. Explain the difference.",
      },
      {
        role: "accountant",
        content:
          "Payments less refunds less fees for October comes to $3,657.80, but Dodo paid out $3,558.80 and the bank confirms that amount landed on 2025-10-31. The $99.00 difference is exactly dispute dsp_7iu96cuq03kr on payment pay_8y4ow7qxour0qj, which Dodo records as lost on 2025-10-16. No ledger row carries that dispute, so the payout is right and the books are wrong: Dodo Clearing is overstated by $99.00.",
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
            description:
              "Expected payout of $3,657.80 versus actual $3,558.80 for October 2025.",
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
        content: "STR-2025-09 is an $18,500.00 invoice. Who approved it?",
      },
      {
        role: "accountant",
        content:
          "Nobody. approved_by is empty on this invoice, and it is the only invoice over $10,000 in the year without an approver. The pricing is correct at the contract rate and the expense is booked normally, so this is a control failure rather than a valuation error. I cannot produce an approval that does not exist.",
        citations: [
          { table: "invoices", id: 9, field: "approved_by", reason: "The approval field is empty on an invoice above the approval threshold." },
          { table: "invoices", id: 9, field: "amount", reason: "The amount is above the $10,000 approval threshold." },
          { table: "contracts", id: 1, field: "monthly_rate", reason: "The amount is at the contract rate, so only the approval is missing." },
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
          "MDC-2025-12 is dated after the Meridian contract ends. On what authority was it paid?",
      },
      {
        role: "accountant",
        content:
          "None that I can cite. Contract 4 runs to 2025-11-30 and there is no renewal in the contract table. The invoice is issued 2025-12-01 for $6,800.00, one day outside the term, and it was approved and booked to Contractors. The work may well have happened, but nothing on file authorises billing for December.",
        citations: [
          { table: "contracts", id: 4, field: "effective_to", reason: "The contract term ends the day before the invoice was issued." },
          { table: "invoices", id: 49, field: "issue_date", reason: "The invoice date falls outside the contract term." },
          { table: "invoices", id: 49, field: "amount", reason: "The amount billed outside the term." },
          { table: "invoices", id: 49, field: "approved_by", reason: "The out-of-term invoice was approved and paid." },
          { table: "ledger_entries", id: 1423, field: "debit", reason: "Contractors expensed for a period the contract does not cover." },
        ],
        gaps: [
          {
            kind: "outside_contract_term",
            description:
              "Invoice 49 is issued after contract 4's effective_to date with no renewal on file.",
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
          "STR-2025-01 is the largest single expense in January. Show contract authority, approval, and settlement.",
      },
      {
        role: "accountant",
        content:
          "All three are on file. Contract 1 sets the Stratus monthly rate at $18,500.00 from 2025-01-01 through 2025-12-31, and this invoice bills exactly that on 2025-01-01. Priya Natarajan approved it. The bank settles reference STR-2025-01 once, on 2025-01-24, for the same amount, and the journal balances: Cloud Infrastructure debited on issue, Cash credited on settlement.",
        citations: [
          { table: "contracts", id: 1, field: "monthly_rate", reason: "The contracted rate the invoice bills." },
          { table: "contracts", id: 1, field: "effective_to", reason: "The invoice date falls inside the contract term." },
          { table: "invoices", id: 1, field: "amount", reason: "The billed amount equals the contract rate exactly." },
          { table: "invoices", id: 1, field: "approved_by", reason: "The invoice carries a named approver." },
          { table: "bank_transactions", id: 20, field: "amount", reason: "A single settlement for the full invoice amount." },
          { table: "ledger_entries", id: 1, field: "debit", reason: "Expense recognised on the invoice date." },
          { table: "ledger_entries", id: 86, field: "credit", reason: "Cash credited once on settlement." },
        ],
        gaps: [],
      },
    ],
  },
  {
    ref: { type: "invoice", id: 20 },
    status: "defended",
    turns: [
      {
        role: "auditor",
        content: "August rent, $9,200.00. Prove it.",
      },
      {
        role: "accountant",
        content:
          "Contract 2 fixes Harbor Point rent at $9,200.00 a month through 2025-12-31, and HPP-2025-08 bills exactly that on 2025-08-01 with Elena Fischer's approval. The bank settles it once on 2025-08-10 and the journal balances: Rent debited on issue, Cash credited on settlement, same amount both sides.",
        citations: [
          { table: "contracts", id: 2, field: "monthly_rate", reason: "The contracted rent amount." },
          { table: "invoices", id: 20, field: "amount", reason: "The invoice bills the contract rate." },
          { table: "invoices", id: 20, field: "approved_by", reason: "The invoice carries a named approver." },
          { table: "bank_transactions", id: 175, field: "amount", reason: "One settlement for the full amount." },
          { table: "ledger_entries", id: 837, field: "debit", reason: "Rent expense recognised on the invoice date." },
          { table: "ledger_entries", id: 886, field: "credit", reason: "Cash credited on settlement." },
        ],
        gaps: [],
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
          "Meridian's contract expires this year. Confirm MDC-2025-04 falls inside the term and was paid once.",
      },
      {
        role: "accountant",
        content:
          "It does. Contract 4 runs 2025-01-01 to 2025-11-30, so an issue date of 2025-04-01 is comfortably inside the term, and the $6,800.00 billed equals the contract monthly rate. Priya Natarajan approved it, the bank settles it once on 2025-04-18, and the debit and credit match.",
        citations: [
          { table: "contracts", id: 4, field: "effective_from", reason: "The contract is in force before the invoice date." },
          { table: "contracts", id: 4, field: "effective_to", reason: "The contract is still in force on the invoice date." },
          { table: "invoices", id: 41, field: "amount", reason: "The invoice bills the contract monthly rate." },
          { table: "bank_transactions", id: 91, field: "amount", reason: "A single settlement for the full amount." },
          { table: "ledger_entries", id: 351, field: "debit", reason: "Contractors expense recognised on the invoice date." },
          { table: "ledger_entries", id: 412, field: "credit", reason: "Cash credited once on settlement." },
        ],
        gaps: [],
      },
    ],
  },
  {
    ref: { type: "bank_transaction", id: 20 },
    status: "defended",
    turns: [
      {
        role: "auditor",
        content: "Bank row 20, $18,500.00 out on 2025-01-24. Tie it to a document.",
      },
      {
        role: "accountant",
        content:
          "The reference on the payment is the invoice number: STR-2025-01, invoice 1 from Stratus Compute Inc. for the same $18,500.00, approved by Priya Natarajan. The payment clears the payable rather than creating an expense, so Accounts Payable is debited and Cash credited on the same date.",
        citations: [
          { table: "bank_transactions", id: 20, field: "reference", reason: "The payment reference is the invoice number it settles." },
          { table: "bank_transactions", id: 20, field: "amount", reason: "The payment equals the invoice amount exactly." },
          { table: "invoices", id: 1, field: "invoice_number", reason: "The invoice named by the payment reference." },
          { table: "ledger_entries", id: 85, field: "debit", reason: "Accounts Payable cleared by the payment." },
          { table: "ledger_entries", id: 86, field: "credit", reason: "Cash credited once for the payment." },
        ],
        gaps: [],
      },
    ],
  },
  {
    ref: { type: "dodo_transaction", id: 81 },
    status: "defended",
    turns: [
      {
        role: "auditor",
        content: "Reconcile the March Dodo payout to the bank and the clearing account.",
      },
      {
        role: "accountant",
        content:
          "March reconciles exactly. Dodo paid out $3,051.84 on 2025-03-31 and the bank shows the same amount landing the same day. The month's processing fees of $144.16 are booked to Payment Processing Fees against Dodo Clearing, and the payout clears the remaining balance: Cash debited, Dodo Clearing credited, same figure. The clearing account nets to zero for the month.",
        citations: [
          { table: "dodo_transactions", id: 81, field: "amount", reason: "The payout amount Dodo reports." },
          { table: "bank_transactions", id: 75, field: "amount", reason: "The bank received the payout amount unchanged." },
          { table: "ledger_entries", id: 343, field: "debit", reason: "Processing fees for the month booked against clearing." },
          { table: "ledger_entries", id: 335, field: "debit", reason: "Cash debited for the payout." },
          { table: "ledger_entries", id: 336, field: "credit", reason: "Dodo Clearing credited so the month nets to zero." },
        ],
        gaps: [],
      },
    ],
  },
];

type Row = Record<string, string>;
type Tables = Record<TableName, Map<number, Row>>;

export async function buildMockRun(runId: string): Promise<RunView> {
  const tables = await loadRows();
  const samples = SAMPLES.map((spec) => buildSample(spec, tables));
  return { id: runId, name: "Northwind Labs FY2025 — walkthrough sample", samples };
}

function buildSample(spec: SampleSpec, tables: Tables): SampleView {
  const id = formatSampleId(spec.ref);
  const source = sourceRow(spec.ref, tables);
  const thread: MessageView[] = spec.turns.map((turn, i) => {
    if (turn.role === "auditor") return { turn: i + 1, role: "auditor", content: turn.content };
    return {
      turn: i + 1,
      role: "accountant",
      content: turn.content,
      evidence: {
        sample: spec.ref,
        citations: turn.citations.map((c) => resolve(c, tables)),
        gaps: turn.gaps,
        defense: turn.content,
      },
    };
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
    return `${vendor?.name ?? "Unknown vendor"} · ${source.invoice_number}`;
  }
  if (ref.type === "bank_transaction") {
    return `${source.counterparty} · ${source.reference}`;
  }
  // Refund and dispute references carry a trailing "for pay_..." clause.
  return `Dodo ${source.type} · ${source.reference.split(" ")[0]}`;
}

function sourceRow(ref: SampleRef, tables: Tables): Row {
  const table: TableName =
    ref.type === "invoice"
      ? "invoices"
      : ref.type === "bank_transaction"
        ? "bank_transactions"
        : "dodo_transactions";
  const row = tables[table].get(ref.id);
  if (!row) throw new Error(`Mock run references ${table} row ${ref.id}, which is not in the database.`);
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
      if (turn.role !== "accountant") continue;
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
      ? db
          .select()
          .from(schema.bankTransactions)
          .where(inArray(schema.bankTransactions.id, bankIds))
      : [],
    dodoIds.length
      ? db
          .select()
          .from(schema.dodoTransactions)
          .where(inArray(schema.dodoTransactions.id, dodoIds))
      : [],
    ledgerIds.length
      ? db.select().from(schema.ledgerEntries).where(inArray(schema.ledgerEntries.id, ledgerIds))
      : [],
  ]);

  // Invoice rows carry the vendor id, so the vendor set is only known after the
  // invoices are loaded.
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

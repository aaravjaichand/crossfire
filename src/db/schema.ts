import {
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { EvidenceBundle } from "@/lib/accountant/types";

// Money is numeric(12,2), dates are `date`, ids are serial integers.
const money = (name: string) => numeric(name, { precision: 12, scale: 2 });

export const vendors = pgTable("vendors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // Plain nullable integer on purpose: a real FK here would be circular with
  // contracts.vendor_id. The seed fills it in after contracts are inserted.
  contractId: integer("contract_id"),
});

export const contracts = pgTable("contracts", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id")
    .notNull()
    .references(() => vendors.id),
  filePath: text("file_path").notNull(),
  monthlyRate: money("monthly_rate").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to").notNull(),
  termsText: text("terms_text").notNull(),
});

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  vendorId: integer("vendor_id")
    .notNull()
    .references(() => vendors.id),
  invoiceNumber: text("invoice_number").notNull(),
  issueDate: date("issue_date").notNull(),
  dueDate: date("due_date").notNull(),
  amount: money("amount").notNull(),
  status: text("status").notNull(),
  approvedBy: text("approved_by"),
  filePath: text("file_path").notNull(),
});

// Signed amounts: positive = money in, negative = money out.
export const bankTransactions = pgTable("bank_transactions", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  description: text("description").notNull(),
  amount: money("amount").notNull(),
  counterparty: text("counterparty").notNull(),
  reference: text("reference").notNull(),
});

export const dodoTransactionType = pgEnum("dodo_transaction_type", [
  "payment",
  "refund",
  "dispute",
  "payout",
]);

export const dodoTransactions = pgTable("dodo_transactions", {
  id: serial("id").primaryKey(),
  type: dodoTransactionType("type").notNull(),
  date: date("date").notNull(),
  amount: money("amount").notNull(),
  customerId: text("customer_id"),
  reference: text("reference").notNull(),
});

// One row per journal line. A balanced journal entry is two rows that share
// a memo/source: one with a debit, one with a credit.
export const ledgerEntries = pgTable("ledger_entries", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  account: text("account").notNull(),
  debit: money("debit").notNull().default("0.00"),
  credit: money("credit").notNull().default("0.00"),
  memo: text("memo").notNull(),
  // invoice | bank | dodo | payroll | adjustment
  sourceType: text("source_type").notNull(),
  // Row id in the source table named by source_type (null for adjustments).
  sourceId: integer("source_id"),
});

// One row per sample drawn into an audit run by the auditor agent.
// sample_type + sample_id identify the underlying row (bank_transactions,
// invoices, or dodo_transactions); there is no FK since the target table
// varies.
export const auditSamples = pgTable("audit_samples", {
  id: serial("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => auditRuns.id),
  // bank_transaction | invoice | dodo_transaction
  sampleType: text("sample_type").notNull(),
  sampleId: integer("sample_id").notNull(),
  amount: money("amount").notNull(),
  riskScore: real("risk_score").notNull(),
  riskReasons: jsonb("risk_reasons").notNull().$type<string[]>(),
  // open | defended | gap | conceded
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One row per turn in the auditor/accountant/referee conversation for a
// sample. role="accountant" turns carry an EvidenceBundle in `evidence`.
export const auditExchanges = pgTable("audit_exchanges", {
  id: serial("id").primaryKey(),
  runId: integer("run_id")
    .notNull()
    .references(() => auditRuns.id),
  sampleId: integer("sample_id")
    .notNull()
    .references(() => auditSamples.id),
  turn: integer("turn").notNull(),
  // auditor | accountant
  role: text("role").notNull(),
  questionTemplateId: text("question_template_id"),
  content: text("content").notNull(),
  // Set when role = accountant. EvidenceBundle is the canonical type from
  // src/lib/accountant/types.ts.
  evidence: jsonb("evidence").$type<EvidenceBundle>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// No FKs to the audit tables: a run can be refereed before its rows exist (the
// UI ships with a mock run), so run_id is text and holds either an audit_runs
// id rendered as a string or a synthetic id such as "mock".
export const refereeDecisions = pgTable("referee_decisions", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull(),
  // bank_transaction | invoice | dodo_transaction
  sampleType: text("sample_type").notNull(),
  sampleId: integer("sample_id").notNull(),
  // approve | redirect | concede
  decision: text("decision").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const learnedRules = pgTable("learned_rules", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One row per auditor CLI/app run. Appended here per Worker B's ownership.
export const auditRuns = pgTable("audit_runs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // running | complete
  status: text("status").notNull(),
  sampleCount: integer("sample_count").notNull(),
  notes: text("notes"),
});

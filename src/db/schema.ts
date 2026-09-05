import {
  date,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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

// Placeholder tables. Other workers add columns later.
export const auditSamples = pgTable("audit_samples", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const auditExchanges = pgTable("audit_exchanges", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const refereeDecisions = pgTable("referee_decisions", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const learnedRules = pgTable("learned_rules", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
import type { Citation, DefenseSource, EvidenceBundle } from "@/lib/accountant/types";
import type {
  AssistantDraft,
  AssistantToolCall,
  AssistantToolResult,
} from "@/lib/assistant/types";

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
  // Set by the referee when a ruling sends a sample back for more work: the
  // controller's note, which the engine appends to the accountant's search
  // context on the next pass and then clears. Owned by the referee module;
  // declared here so the engine can read and clear it. Written only by the
  // needs_more verdict; every other verdict clears it in the same transaction
  // that files the ruling.
  pendingFollowUp: text("pending_follow_up"),
  // Lease held while a worker is settling this sample. Claimed atomically so
  // two concurrent advance calls can never work the same sample; a lease older
  // than CLAIM_LEASE_MS is reclaimable, so a process killed mid-sample (a
  // serverless invocation ending) does not strand it. See src/lib/engine/run.ts.
  claimedAt: timestamp("claimed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // How a settled sample was settled, when it was settled by anything other
  // than the evidence in its own thread. "memory" means a controller ruling
  // from an earlier run disposed of it (src/lib/accountant/memory.ts); null
  // means the ordinary path. Written by the engine, read by the run screen and
  // the binder so neither has to infer it from the transcript.
  resolution: text("resolution"),
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
  // Audit procedure this turn exercises, set on role="auditor" rows only:
  // three_way_match | cutoff | unrecorded_liabilities | bank_rec |
  // revenue_tie_out | approval_control. See src/lib/auditor/questions.ts.
  procedure: text("procedure"),
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
  // sufficient | needs_more | exception | accepted_with_note
  decision: text("decision").notNull(),
  // recover_cash | post_entry | fix_control | investigate. Set on exception
  // verdicts and null on the rest.
  remedy: text("remedy"),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One row per controller ruling that carries judgement the accountant can
// reuse: every exception, accepted_with_note, and needs_more verdict. A
// sufficient verdict teaches nothing and writes nothing.
//
// run_id is text for the same reason refereeDecisions.run_id is: the mock run
// has no audit_runs row.
export const learnedRules = pgTable("learned_rules", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull(),
  // bank_transaction | invoice | dodo_transaction
  sampleType: text("sample_type").notNull(),
  sampleId: integer("sample_id").notNull(),
  // The GapKind the accountant admitted on its last turn, or "other".
  gapKind: text("gap_kind").notNull(),
  // Vendor name, bank counterparty, or Dodo transaction type.
  counterparty: text("counterparty").notNull(),
  remedy: text("remedy"),
  note: text("note"),
  // sufficient | needs_more | exception | accepted_with_note
  verdict: text("verdict").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// One row per auditor CLI/app run, with the inputs the run was started with
// so it can be reproduced exactly.
export const auditRuns = pgTable("audit_runs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // running | complete | failed
  status: text("status").notNull(),
  sampleCount: integer("sample_count").notNull(),
  notes: text("notes"),
  // ---- run inputs ----
  // PRNG seed. Same seed + same books + same inputs => same picks.
  seed: integer("seed").notNull().default(1),
  // Materiality in cents. Every candidate at or above this is always sampled.
  materiality: integer("materiality").notNull().default(5_000_000),
  // Target sample size; materiality-forced picks may push the run past it.
  sampleSize: integer("sample_size").notNull().default(25),
  // Subset of: purchases, cash, revenue, payroll.
  cycles: jsonb("cycles")
    .notNull()
    .$type<string[]>()
    .default(["purchases", "cash", "revenue", "payroll"]),
  // ---- progress ----
  // Samples settled so far (defended or gap), for polling while status is
  // "running". Always incremented in SQL, never read-modify-written.
  progress: integer("progress").notNull().default(0),
});

// ---- the controller's assistant ----
//
// One thread per conversation, one row per turn. run_id is text and FK-free
// for the same reason referee_decisions.run_id is: the walkthrough has no
// audit_runs row. A draft on a message is a note or remedy the human has not
// filed; it is never a ruling, and nothing in src/lib/assistant writes to
// referee_decisions or learned_rules.
export const assistantThreads = pgTable("assistant_threads", {
  id: serial("id").primaryKey(),
  // First user message, trimmed to ~80 chars. Written once, on creation.
  title: text("title").notNull(),
  // Run key ("7" or "mock").
  runId: text("run_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const assistantMessages = pgTable("assistant_messages", {
  id: serial("id").primaryKey(),
  threadId: integer("thread_id")
    .notNull()
    .references(() => assistantThreads.id),
  turn: integer("turn").notNull(),
  // user | assistant
  role: text("role").notNull(),
  content: text("content").notNull(),
  toolCalls: jsonb("tool_calls").$type<AssistantToolCall[]>(),
  toolResults: jsonb("tool_results").$type<AssistantToolResult[]>(),
  citations: jsonb("citations").$type<Citation[]>(),
  // A note or remedy the human has not filed. Never a ruling.
  draft: jsonb("draft").$type<AssistantDraft>(),
  runId: text("run_id"),
  // "invoice:24"
  sampleRef: text("sample_ref"),
  // Mirrors EvidenceBundle.defenseSource: model | fallback, plus why.
  answerSource: jsonb("answer_source").$type<DefenseSource>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

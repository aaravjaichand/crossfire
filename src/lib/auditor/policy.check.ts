/**
 * pnpm auditor:check-policy
 *
 * Quick, no-framework unit check for decide() on hand-built EvidenceBundles
 * covering accept, push-back, and escalate, including the regression cases
 * from review: an "other" gap must escalate immediately (not loop on
 * push-back until turn 3), and a closeable gap must still escalate once
 * turn >= 3.
 */
import type { EvidenceBundle } from "./evidence-types";
import { decide } from "./policy";

type Case = { name: string; bundle: EvidenceBundle; turn: number; expect: "accept" | "push_back" | "escalate" };

const cases: Case[] = [
  {
    name: "clean invoice payment, one citation covers the amount, no gaps",
    bundle: {
      sample: { type: "bank_transaction", id: 42 },
      citations: [
        {
          table: "invoices",
          id: 7,
          field: "amount",
          value: "1450.00",
          reason: "Invoice NWK-2025-08 for $1,450.00 matches this payment exactly.",
        },
      ],
      gaps: [],
    },
    turn: 1,
    expect: "accept",
  },
  {
    name: "missing ledger entry on turn 1, plausibly closeable with another search",
    bundle: {
      sample: { type: "dodo_transaction", id: 92 },
      citations: [
        {
          table: "dodo_transactions",
          id: 92,
          field: "amount",
          value: "499.00",
          reason: "The refund row itself confirms the amount.",
        },
      ],
      gaps: [{ kind: "missing_ledger_entry", description: "No ledger_entries row with source_type=dodo, source_id=92." }],
    },
    turn: 1,
    expect: "push_back",
  },
  {
    name: "structural gap (missing approval) escalates immediately",
    bundle: {
      sample: { type: "invoice", id: 9 },
      citations: [
        { table: "invoices", id: 9, field: "amount", value: "18500.00", reason: "Invoice row shows the billed amount." },
      ],
      gaps: [{ kind: "missing_approval", description: "approved_by is null on an invoice over $10,000." }],
    },
    turn: 1,
    expect: "escalate",
  },
  {
    name: "'other' gap escalates immediately on turn 1, not a push-back loop",
    bundle: {
      sample: { type: "bank_transaction", id: 202 },
      citations: [
        { table: "bank_transactions", id: 202, field: "amount", value: "7850.00", reason: "The bank row shows the wired amount." },
      ],
      gaps: [{ kind: "other", description: "Counterparty does not match any known category; cause unclear." }],
    },
    turn: 1,
    expect: "escalate",
  },
  {
    name: "closeable gap still escalates once turn >= 3 (search budget exhausted)",
    bundle: {
      sample: { type: "dodo_transaction", id: 92 },
      citations: [
        { table: "dodo_transactions", id: 92, field: "amount", value: "499.00", reason: "The refund row itself confirms the amount." },
      ],
      gaps: [{ kind: "missing_ledger_entry", description: "Still no ledger_entries row after two more searches." }],
    },
    turn: 3,
    expect: "escalate",
  },
  {
    name: "no gaps but no citation covers the amount: push back for one",
    bundle: {
      sample: { type: "invoice", id: 4 },
      citations: [
        { table: "vendors", id: 1, field: "name", value: "Stratus Compute Inc.", reason: "Confirms the vendor exists." },
      ],
      gaps: [],
    },
    turn: 1,
    expect: "push_back",
  },
  {
    name: "no_bank_match gap on turn 2 is still closeable, pushes back",
    bundle: {
      sample: { type: "bank_transaction", id: 907 },
      citations: [
        { table: "ledger_entries", id: 907, field: "debit", value: "1875.00", reason: "The adjustment entry shows the amount." },
      ],
      gaps: [{ kind: "no_bank_match", description: "No bank_transactions row on or near 2025-08-14 for $1,875.00." }],
    },
    turn: 2,
    expect: "push_back",
  },
];

let failures = 0;
for (const c of cases) {
  const result = decide(c.bundle, c.turn);
  const ok = result.action === c.expect;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(`      expected=${c.expect} actual=${result.action}${result.followUp ? ` followUp="${result.followUp}"` : ""}`);
}

if (failures > 0) {
  console.error(`\n${failures} of ${cases.length} case(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} cases passed.`);

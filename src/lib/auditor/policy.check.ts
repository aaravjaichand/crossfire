/**
 * pnpm auditor:check-policy
 *
 * Quick, no-framework unit check for decide() on three hand-built
 * EvidenceBundles: one that should be accepted, one that should get a
 * targeted push-back, and one that should escalate to the referee.
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

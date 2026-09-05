/**
 * pnpm test:accountant
 *
 * Deterministic and free: reads data/planted_issues.json, maps every planted
 * issue to the sample an auditor would pull, runs gatherEvidence (no LLM), and
 * asserts each planted sample raises the gap it was planted for while five
 * fixed clean samples raise none.
 */
import "./lib/env";
import { readFile } from "node:fs/promises";
import { and, asc, gte, lte } from "drizzle-orm";
import { db, sql } from "../src/db";
import { bankTransactions } from "../src/db/schema";
import {
  formatSampleId,
  gatherEvidence,
  parseSampleId,
  type GapKind,
} from "../src/lib/accountant";

type Manifest = {
  issues: {
    id: number;
    slug: string;
    description: string;
    records: Record<string, Record<string, unknown>>;
  }[];
};

/**
 * How each planted issue becomes a sample. Sample ids come from the manifest so
 * a reseed cannot silently drift; only issue 8 needs a rule, because it has no
 * source record at all (see note).
 */
const EXPECTED: Record<
  string,
  { kind: GapKind; resolve: (records: Manifest["issues"][number]["records"]) => Promise<string> }
> = {
  "invoice-paid-twice": {
    kind: "duplicate_payment",
    resolve: async (r) => `invoice:${firstId(r, "invoices")}`,
  },
  "invoice-above-contract-rate": {
    kind: "rate_mismatch",
    resolve: async (r) => `invoice:${firstId(r, "invoices")}`,
  },
  "bank-payment-without-invoice": {
    kind: "no_matching_invoice",
    resolve: async (r) => `bank:${firstId(r, "bank_transactions")}`,
  },
  "large-invoice-not-approved": {
    kind: "missing_approval",
    resolve: async (r) => `invoice:${firstId(r, "invoices")}`,
  },
  "dodo-refund-missing-from-ledger": {
    kind: "missing_ledger_entry",
    resolve: async (r) => `dodo:${firstId(r, "dodo_transactions")}`,
  },
  "dodo-payout-short-by-unrecorded-dispute": {
    kind: "payout_mismatch",
    // The dispute is the record that was never booked; sampling it pulls in the
    // October payout and its bank deposit.
    resolve: async (r) => `dodo:${num(r.dodo_transactions.dispute_id)}`,
  },
  "invoice-after-contract-end": {
    kind: "outside_contract_term",
    resolve: async (r) => `invoice:${firstId(r, "invoices")}`,
  },
  "ledger-entry-without-bank-transaction": {
    kind: "no_bank_match",
    // This issue lives only in the ledger, and a sample ref must be a bank,
    // invoice or dodo row. The auditor reaches it through the bank feed: we
    // sample the bank line closest to the orphan entry's date, and the
    // accountant's cash reconciliation for that date finds the orphan.
    resolve: async (r) => `bank:${await bankLineNearest(str(r.ledger_entries.date))}`,
  },
  "bank-payment-to-unknown-counterparty": {
    kind: "unknown_counterparty",
    resolve: async (r) => `bank:${firstId(r, "bank_transactions")}`,
  },
  "two-invoices-same-vendor-same-month": {
    kind: "duplicate_invoice_month",
    resolve: async (r) => `invoice:${firstId(r, "invoices")}`,
  },
};

/** Fixed non-planted samples: two invoices, two bank payments, one Dodo payment. */
const CLEAN_SAMPLES = [
  "invoice:1", // STR-2025-01, at contract rate, approved, paid once
  "invoice:50", // BHI-2025-01, same
  "bank:20", // ACH payment STR-2025-01
  "bank:12", // ACH payment HPP-2025-01
  "dodo:13", // Dodo payment pay_qoj70lmodpl55l, no refund or dispute against it
];

async function main() {
  const manifest: Manifest = JSON.parse(await readFile("data/planted_issues.json", "utf8"));
  let failures = 0;
  const fail = (message: string) => {
    failures += 1;
    console.log(`FAIL  ${message}`);
  };

  console.log("Planted issues (gatherEvidence, no LLM)");
  console.log("--------------------------------------");
  for (const issue of manifest.issues) {
    const expected = EXPECTED[issue.slug];
    if (!expected) {
      fail(`issue ${issue.id} ${issue.slug}: no sample mapping in this test`);
      continue;
    }
    const sampleId = await expected.resolve(issue.records);
    const bundle = await gatherEvidence(parseSampleId(sampleId));
    const kinds = bundle.gaps.map((g) => g.kind);
    const label = `issue ${String(issue.id).padStart(2)} ${issue.slug.padEnd(41)} ${sampleId.padEnd(12)}`;

    if (bundle.gaps.length === 0) {
      fail(`${label} no gaps found`);
    } else if (!kinds.includes(expected.kind)) {
      fail(`${label} expected ${expected.kind}, got ${kinds.join(", ")}`);
    } else if (bundle.citations.length === 0) {
      fail(`${label} raised gaps with no citations`);
    } else {
      console.log(
        `PASS  ${label} ${bundle.citations.length} citations, gaps: ${kinds.join(", ")}`,
      );
    }
  }

  console.log("");
  console.log("Clean samples (expect zero gaps)");
  console.log("--------------------------------");
  for (const sampleId of CLEAN_SAMPLES) {
    const sample = parseSampleId(sampleId);
    const bundle = await gatherEvidence(sample);
    const label = formatSampleId(sample).padEnd(12);
    if (bundle.gaps.length > 0) {
      fail(
        `${label} expected no gaps, got: ${bundle.gaps.map((g) => `${g.kind} (${g.description})`).join(" | ")}`,
      );
    } else if (bundle.citations.length === 0) {
      fail(`${label} produced no citations`);
    } else {
      console.log(`PASS  ${label} ${bundle.citations.length} citations, no gaps`);
    }
  }

  const total = manifest.issues.length + CLEAN_SAMPLES.length;
  console.log("");
  console.log(`${total - failures}/${total} accountant checks passed.`);
  await sql.end();
  process.exit(failures === 0 ? 0 : 1);
}

// ---------- manifest helpers ----------

function firstId(records: Manifest["issues"][number]["records"], table: string): number {
  const ids = records[table]?.ids;
  if (!Array.isArray(ids) || typeof ids[0] !== "number") {
    throw new Error(`Manifest is missing ${table}.ids`);
  }
  return ids[0];
}

function num(value: unknown): number {
  if (typeof value !== "number") throw new Error(`Expected a number in the manifest, got ${value}`);
  return value;
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Error(`Expected a string in the manifest, got ${value}`);
  return value;
}

/** Bank line nearest a date, preferring the first one on or after it. */
async function bankLineNearest(date: string): Promise<number> {
  const window = 7;
  const rows = await db
    .select()
    .from(bankTransactions)
    .where(
      and(
        gte(bankTransactions.date, addDays(date, -window)),
        lte(bankTransactions.date, addDays(date, window)),
      ),
    )
    .orderBy(asc(bankTransactions.date), asc(bankTransactions.id));
  const onOrAfter = rows.find((r) => r.date >= date);
  const row = onOrAfter ?? rows[rows.length - 1];
  if (!row) throw new Error(`No bank transaction within ${window} days of ${date}`);
  return row.id;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});

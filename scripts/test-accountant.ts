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
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db, sql } from "../src/db";
import { bankTransactions, dodoTransactions, ledgerEntries } from "../src/db/schema";
import {
  buildFallbackDefense,
  classifyLedgerRows,
  classifyPaymentLink,
  finalizeDefense,
  formatSampleId,
  gatherEvidence,
  keepOnlyCitedRows,
  parseSampleId,
  paymentWindow,
  validateDefense,
  type EvidenceBundle,
  type GapKind,
  type PaymentCandidate,
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

  const sampleChecks = manifest.issues.length + CLEAN_SAMPLES.length;
  console.log("");
  console.log(`${sampleChecks - failures}/${sampleChecks} planted and clean checks passed.`);

  const extra = [
    await paymentMatchingChecks(),
    await dodoLedgerChecks(),
    await citationInvariantChecks(),
  ];
  const extraFailures = extra.reduce((s, r) => s + r.failed, 0);
  const extraTotal = extra.reduce((s, r) => s + r.total, 0);

  const total = sampleChecks + extraTotal;
  const allFailures = failures + extraFailures;
  console.log("");
  console.log(`${total - allFailures}/${total} accountant checks passed.`);
  await sql.end();
  process.exit(allFailures === 0 ? 0 : 1);
}

// ---------- focused checks ----------

type Result = { total: number; failed: number };

function section(title: string): Result & { expect: (label: string, ok: boolean, detail?: string) => void } {
  console.log("");
  console.log(title);
  console.log("-".repeat(title.length));
  const result = {
    total: 0,
    failed: 0,
    expect(label: string, ok: boolean, detail?: string) {
      result.total += 1;
      if (ok) {
        console.log(`PASS  ${label}`);
      } else {
        result.failed += 1;
        console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
      }
    },
  };
  return result;
}

/**
 * The bounded payment rule, exercised against rows that do not exist in the
 * seed: quoting an invoice number must not be enough to attach a bank line.
 */
async function paymentMatchingChecks(): Promise<Result> {
  const s = section("Payment matching rule (pure, synthetic rows)");
  // STR-2025-01: issued 2025-01-01, net 30, so the window is 2024-12-25 to 2025-02-07.
  const base: PaymentCandidate = {
    invoiceNumber: "STR-2025-01",
    invoiceAmountCents: 1_850_000,
    issueDate: "2025-01-01",
    dueDate: "2025-01-31",
    vendorName: "Stratus Compute Inc.",
    bankReference: "STR-2025-01",
    bankCounterparty: "Stratus Compute Inc.",
    bankAmountCents: -1_850_000,
    bankDate: "2025-01-24",
    referenceClaimedByAnotherInvoice: false,
  };
  const window = paymentWindow(base);
  const link = (patch: Partial<PaymentCandidate>) => classifyPaymentLink({ ...base, ...patch });

  s.expect(
    `window is ${window.from} to ${window.to}`,
    window.from === "2024-12-25" && window.to === "2025-02-07",
    `${window.from} to ${window.to}`,
  );

  const matched = link({});
  s.expect(
    "exact reference with matching vendor, amount and date matches",
    matched.matched && matched.via === "reference",
  );

  const wrongVendor = link({ bankCounterparty: "Kestrel Holdings Ltd" });
  s.expect(
    "exact reference to the wrong counterparty is rejected",
    !wrongVendor.matched && wrongVendor.reason === "counterparty",
    JSON.stringify(wrongVendor),
  );

  const wrongAmount = link({ bankAmountCents: -1_845_000 });
  s.expect(
    "exact reference for the wrong amount is rejected",
    !wrongAmount.matched && wrongAmount.reason === "amount",
    JSON.stringify(wrongAmount),
  );

  const tooLate = link({ bankDate: "2025-02-08" });
  s.expect(
    "exact reference one day past the bounded window is rejected",
    !tooLate.matched && tooLate.reason === "outside_window",
    JSON.stringify(tooLate),
  );

  const tooEarly = link({ bankDate: "2024-12-24" });
  s.expect(
    "exact reference one day before the bounded window is rejected",
    !tooEarly.matched && tooEarly.reason === "outside_window",
    JSON.stringify(tooEarly),
  );

  const firstDay = link({ bankDate: "2024-12-25" });
  const lastDay = link({ bankDate: "2025-02-07" });
  s.expect(
    "both window boundaries are inclusive",
    firstDay.matched && lastDay.matched,
    `${JSON.stringify(firstDay)} / ${JSON.stringify(lastDay)}`,
  );

  const deposit = link({ bankAmountCents: 1_850_000 });
  s.expect(
    "a deposit quoting the invoice number is rejected",
    !deposit.matched && deposit.reason === "not_a_payment",
    JSON.stringify(deposit),
  );

  const unreferenced = link({ bankReference: "ACH-20250124-STR" });
  s.expect(
    "an unreferenced line to the same vendor for the same amount in window matches",
    unreferenced.matched && unreferenced.via === "vendor_amount_window",
    JSON.stringify(unreferenced),
  );

  const claimed = link({
    bankReference: "STR-2025-02",
    referenceClaimedByAnotherInvoice: true,
  });
  s.expect(
    "a line quoting another invoice's number is left to that invoice",
    !claimed.matched && claimed.reason === "claimed_elsewhere",
    JSON.stringify(claimed),
  );

  const rejected = link({ bankCounterparty: "Kestrel Holdings Ltd" });
  s.expect(
    "a rejected quoting line is reported rather than dropped in silence",
    !rejected.matched && rejected.quotesInvoice,
    JSON.stringify(rejected),
  );

  return { total: s.total, failed: s.failed };
}

/** Linked Dodo events (the original payment and the monthly payout) are validated too. */
async function dodoLedgerChecks(): Promise<Result> {
  const s = section("Dodo linked-event ledger evidence");

  s.expect("no ledger rows reads as missing", classifyLedgerRows([]).state === "missing");
  s.expect(
    "a debit with no credit reads as unbalanced",
    classifyLedgerRows([{ debit: "100.00", credit: "0.00" }]).state === "unbalanced",
  );
  s.expect(
    "a debit and a credit read as ok",
    classifyLedgerRows([
      { debit: "100.00", credit: "0.00" },
      { debit: "0.00", credit: "100.00" },
    ]).state === "ok",
  );

  // The refund with no ledger entry (planted issue 5) and the payment it was
  // raised against.
  const refund = (
    await db.select().from(dodoTransactions).where(eq(dodoTransactions.id, 92))
  )[0];
  const originalReference = refund.reference.match(/ for (pay_[a-z0-9]+)/)?.[1] ?? "";
  const original = (
    await db
      .select()
      .from(dodoTransactions)
      .where(eq(dodoTransactions.reference, originalReference))
  )[0];
  s.expect("the refund's original payment is resolvable", Boolean(original), originalReference);
  if (!original) return { total: s.total, failed: s.failed };

  const refundBundle = await gatherEvidence({ type: "dodo_transaction", id: refund.id });
  const originalLedger = await ledgerRowsFor(original.id);
  s.expect(
    `refund sample cites the linked payment's ledger rows (${originalLedger.map((l) => l.id).join(", ")})`,
    originalLedger.length > 0 && originalLedger.every((l) => cites(refundBundle, "ledger_entries", l.id)),
  );

  const payout = (
    await db
      .select()
      .from(dodoTransactions)
      .where(
        and(
          eq(dodoTransactions.type, "payout"),
          gte(dodoTransactions.date, "2025-04-01"),
          lte(dodoTransactions.date, "2025-04-30"),
        ),
      )
  )[0];
  const payoutLedger = await ledgerRowsFor(payout.id);
  s.expect(
    `refund sample cites the monthly payout's ledger rows (${payoutLedger.map((l) => l.id).join(", ")})`,
    payoutLedger.length > 0 && payoutLedger.every((l) => cites(refundBundle, "ledger_entries", l.id)),
  );

  // Sampling the payment surfaces a linked event that is missing its entry:
  // the refund raised against it was never booked.
  const paymentBundle = await gatherEvidence({ type: "dodo_transaction", id: original.id });
  const linkedGap = paymentBundle.gaps.find(
    (g) => g.kind === "missing_ledger_entry" && g.description.includes(refund.reference.split(" ")[0]),
  );
  s.expect(
    "sampling the payment raises missing_ledger_entry for its unbooked refund",
    Boolean(linkedGap),
    paymentBundle.gaps.map((g) => g.kind).join(", ") || "no gaps",
  );

  const disputeBundle = await gatherEvidence({ type: "dodo_transaction", id: 317 });
  const disputeLedgerGap = disputeBundle.gaps.some((g) => g.kind === "missing_ledger_entry");
  const disputePayoutLedger = await ledgerRowsFor(340);
  s.expect(
    "the lost dispute still raises missing_ledger_entry while the payout's own entry is cited",
    disputeLedgerGap &&
      disputePayoutLedger.length > 0 &&
      disputePayoutLedger.every((l) => cites(disputeBundle, "ledger_entries", l.id)),
  );

  return { total: s.total, failed: s.failed };
}

/** Uncited or invalidly cited model prose must not survive. */
async function citationInvariantChecks(): Promise<Result> {
  const s = section("Defense citation invariant (pure, synthetic model prose)");
  const bundle = await gatherEvidence(parseSampleId("invoice:5"));
  const first = bundle.citations[0];
  const anchor = `[${first.table}#${first.id}]`;

  const good = `Invoice STR-2025-05 for $21,275.00 is on file ${anchor}. The reconciliation reports a rate mismatch against the contract rate ${anchor}.`;
  const goodResult = finalizeDefense(good, bundle);
  s.expect(
    "valid prose citing bundle rows survives unchanged",
    goodResult.source === "model" && goodResult.defense === good,
    goodResult.reason,
  );

  const cases: { label: string; text: string }[] = [
    {
      label: "prose citing a gap instead of a row falls back",
      text: "Invoice STR-2025-05 for $21,275.00 is above the contract rate [gaps#1].",
    },
    {
      label: "prose citing a row that is not in the bundle falls back",
      text: "Invoice STR-2025-05 for $21,275.00 is above the contract rate [invoices#999].",
    },
    {
      label: "prose citing a table that does not exist falls back",
      text: "The payment of $21,275.00 cleared on 2025-05-17 [payments#5].",
    },
    {
      label: "factual prose with no citation at all falls back",
      text: "Invoice STR-2025-05 for $21,275.00 was paid on 2025-05-17 and everything ties out.",
    },
    {
      label: "prose asserting a name from the evidence without a citation falls back",
      text: "The invoice was approved by Priya Natarajan and is properly authorised.",
    },
    {
      label: "prose with no facts and no citations falls back",
      text: "We concede this finding and will follow up.",
    },
    {
      label: "a sentence leaning only on invented rows falls back, facts or not",
      text: `Invoice STR-2025-05 is on file ${anchor}. The transaction is fully supported by the ledger entries [ledger_entries#99999] and [ledger_entries#99998].`,
    },
    {
      label: "an empty completion falls back",
      text: "   ",
    },
    {
      label: "one cited sentence does not licence a second uncited factual sentence",
      text: `Invoice STR-2025-05 is on file ${anchor}. It was also paid twice on 2025-06-01 for $9,200.00.`,
    },
  ];
  for (const c of cases) {
    const result = finalizeDefense(c.text, bundle);
    s.expect(
      c.label,
      result.source === "fallback" && result.defense === buildFallbackDefense(bundle),
      `source=${result.source}`,
    );
  }

  const concessive = `Invoice STR-2025-05 for $21,275.00 is on file ${anchor}. The item is not fully supported and we concede it.`;
  const concessiveResult = finalizeDefense(concessive, bundle);
  s.expect(
    "a concession that asserts no specific fact is allowed alongside cited prose",
    concessiveResult.source === "model",
    concessiveResult.reason,
  );

  const invalidStripped = keepOnlyCitedRows(`Rate above contract ${anchor} [gaps#1].`, bundle);
  s.expect(
    "invalid brackets are removed from prose that is otherwise kept",
    invalidStripped.includes(anchor) && !invalidStripped.includes("gaps#1"),
    invalidStripped,
  );

  const fallback = buildFallbackDefense(bundle);
  s.expect(
    "the deterministic fallback satisfies the invariant it enforces",
    validateDefense(fallback, bundle).ok,
    JSON.stringify(validateDefense(fallback, bundle)),
  );
  s.expect(
    "the deterministic fallback states the gap",
    bundle.gaps.every((g) => fallback.includes(g.kind) && fallback.includes(g.description)),
  );

  const clean = await gatherEvidence(parseSampleId("invoice:1"));
  const cleanFallback = buildFallbackDefense(clean);
  s.expect(
    "the fallback for a clean sample says no gap was found and still cites",
    cleanFallback.includes("No reconciliation check") && validateDefense(cleanFallback, clean).ok,
  );

  return { total: s.total, failed: s.failed };
}

function cites(bundle: EvidenceBundle, table: string, id: number): boolean {
  return bundle.citations.some((c) => c.table === table && c.id === id);
}

async function ledgerRowsFor(dodoId: number) {
  return db
    .select()
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.sourceType, "dodo"), eq(ledgerEntries.sourceId, dodoId)));
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

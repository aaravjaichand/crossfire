/**
 * pnpm referee:check-adjustments
 *
 * The proposed adjusting entry is a fixed table, so this check runs without a
 * database and proves the properties the exception panel relies on:
 *   1. Every GapKind has an entry, so an exception can always be shown one.
 *   2. Debit and credit are always different accounts and never empty.
 *   3. The amount is always positive and formatted, whatever the sample's sign.
 *   4. rate_mismatch prices the variance between the cited invoice amount and
 *      the cited contract rate, not the whole invoice.
 *   5. payout_mismatch prices the difference the gap states, not the payout.
 *   6. A rule whose citations are missing falls back to the sampled amount and
 *      says so, rather than showing a figure it cannot support.
 *   7. The basis is only ever citations that were actually on the bundle.
 */
import { ADJUSTMENTS, proposeAdjustment } from "./adjustments";
import type { Citation, GapKind } from "./evidence-types";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const KINDS: GapKind[] = [
  "no_matching_invoice",
  "rate_mismatch",
  "duplicate_payment",
  "missing_approval",
  "missing_ledger_entry",
  "no_bank_match",
  "unknown_counterparty",
  "outside_contract_term",
  "duplicate_invoice_month",
  "payout_mismatch",
  "other",
];

const cite = (table: string, id: number, field: string, value: string): Citation => ({
  table,
  id,
  field,
  value,
  reason: "check fixture",
});

function main() {
  // ---- 1 and 2. the table covers every kind, with two distinct accounts ----
  check(
    "every GapKind has an entry in the table",
    KINDS.every((k) => Boolean(ADJUSTMENTS[k])),
    KINDS.filter((k) => !ADJUSTMENTS[k]).join(",") || "all present",
  );
  check(
    "no entry debits and credits the same account",
    KINDS.every((k) => ADJUSTMENTS[k].debit !== ADJUSTMENTS[k].credit),
  );
  check(
    "every entry names both accounts and carries a memo",
    KINDS.every(
      (k) =>
        ADJUSTMENTS[k].debit.length > 0 &&
        ADJUSTMENTS[k].credit.length > 0 &&
        ADJUSTMENTS[k].memo.length > 0 &&
        ADJUSTMENTS[k].amountSource.length > 0,
    ),
  );

  // ---- 3. every kind produces a positive, formatted amount ----
  const entries = KINDS.map((gapKind) =>
    proposeAdjustment({
      gapKind,
      sampleType: "bank_transaction",
      sampleId: 72,
      sampleAmount: "-9200.00",
      citations: [],
    }),
  );
  check(
    "an outgoing (negative) sample still proposes a positive amount",
    entries.every((e) => e.amount === "$9,200.00"),
    [...new Set(entries.map((e) => e.amount))].join(","),
  );

  // ---- 4. rate_mismatch prices the variance ----
  const rate = proposeAdjustment({
    gapKind: "rate_mismatch",
    sampleType: "invoice",
    sampleId: 5,
    sampleAmount: "9660.00",
    citations: [
      cite("invoices", 5, "amount", "$9,660.00"),
      cite("contracts", 2, "monthly_rate", "9200.00"),
    ],
    gapDescription: "Invoice bills $9,660.00, which is $460.00 (5.0%) above the contract monthly rate of $9,200.00.",
  });
  check("rate_mismatch prices the variance, not the invoice", rate.amount === "$460.00", rate.amount);
  check("it did not fall back", !rate.fellBack);
  check(
    "the basis is the two citations the variance is computed from",
    rate.basis.length === 2 &&
      rate.basis[0].table === "invoices" &&
      rate.basis[1].table === "contracts",
    rate.basis.map((c) => `${c.table}#${c.id}.${c.field}`).join(" "),
  );

  // ---- 5. payout_mismatch prices the stated difference ----
  const payout = proposeAdjustment({
    gapKind: "payout_mismatch",
    sampleType: "dodo_transaction",
    sampleId: 431,
    sampleAmount: "38214.55",
    citations: [cite("dodo_transactions", 431, "amount", "$38,214.55")],
    gapDescription:
      "Month 7 payout po_7 is $38,214.55 but payments less refunds less fees is $38,627.15, a difference of $412.60 which equals the lost dispute dp_3 for $412.60.",
  });
  check("payout_mismatch prices the stated difference", payout.amount === "$412.60", payout.amount);
  check("it did not fall back", !payout.fellBack);
  check(
    "a negative stated difference is still proposed as a positive amount",
    proposeAdjustment({
      gapKind: "payout_mismatch",
      sampleType: "dodo_transaction",
      sampleId: 431,
      sampleAmount: "38214.55",
      citations: [],
      gapDescription: "… a difference of -$412.60.",
    }).amount === "$412.60",
  );

  // ---- 6. fallbacks are visible ----
  const noCitations = proposeAdjustment({
    gapKind: "rate_mismatch",
    sampleType: "invoice",
    sampleId: 5,
    sampleAmount: "9660.00",
    citations: [],
  });
  check("rate_mismatch with no citations falls back to the sample", noCitations.amount === "$9,660.00", noCitations.amount);
  check("the fallback is flagged", noCitations.fellBack);
  check(
    "and the amount source no longer claims to be the rate variance",
    noCitations.amountSource === ADJUSTMENTS.other.amountSource,
    noCitations.amountSource,
  );
  const noDifference = proposeAdjustment({
    gapKind: "payout_mismatch",
    sampleType: "dodo_transaction",
    sampleId: 431,
    sampleAmount: "38214.55",
    citations: [],
    gapDescription: "The payout does not reconcile.",
  });
  check("payout_mismatch with no stated difference falls back", noDifference.fellBack && noDifference.amount === "$38,214.55", noDifference.amount);

  // ---- 7. the basis only ever holds citations that were passed in ----
  const duplicate = proposeAdjustment({
    gapKind: "duplicate_payment",
    sampleType: "bank_transaction",
    sampleId: 73,
    sampleAmount: "-9200.00",
    citations: [
      cite("bank_transactions", 73, "amount", "-9200.00"),
      cite("bank_transactions", 72, "amount", "-9200.00"),
      cite("ledger_entries", 326, "credit", "9200.00"),
    ],
  });
  check("duplicate_payment prices the whole duplicated payment", duplicate.amount === "$9,200.00", duplicate.amount);
  check(
    "the basis is only the sampled row's own citations",
    duplicate.basis.length === 1 && duplicate.basis[0].id === 73,
    duplicate.basis.map((c) => `${c.table}#${c.id}`).join(" "),
  );
  check(
    "a sample with no citation of its own gets an empty basis rather than someone else's",
    proposeAdjustment({
      gapKind: "duplicate_payment",
      sampleType: "bank_transaction",
      sampleId: 73,
      sampleAmount: "-9200.00",
      citations: [cite("ledger_entries", 326, "credit", "9200.00")],
    }).basis.length === 0,
  );
}

main();
if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll referee adjustment checks passed.");

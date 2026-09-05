// Risk-weighted, deterministic sampling of 25 records per audit run from
// bank_transactions, invoices, and dodo_transactions.
//
// Determinism: every DB read is ordered by id, every score is computed with
// plain arithmetic (no Date.now(), no Math.random()), and the final
// selection uses a seeded PRNG (see rng.ts). Same seed + same data => same
// picks, every time.
import { inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import type { SampleType } from "./evidence-types";
import { Rng, weightedSampleIndices } from "./rng";
import { isMonthEnd, toCents, usd, yearOf } from "./util";

export type SampleCandidate = {
  sampleType: SampleType;
  sampleId: number;
  amountCents: number; // signed for bank_transactions, unsigned for invoices/dodo
  date: string;
  riskScore: number;
  riskReasons: string[];
};

// Weights are additive score contributions, not probabilities. They only
// need to be internally consistent so riskier candidates end up with larger
// weights going into the weighted sample.
const WEIGHTS = {
  amount: 0.5, // scaled by percentile rank (0..1)
  roundThousand: 0.18,
  roundHundred: 0.09,
  monthEnd: 0.12,
  newCounterparty: 0.14,
  priorFlag: 0.6,
};

const LARGE_AMOUNT_PERCENTILE = 0.85;

function percentileRank(sortedAbs: number[], value: number): number {
  if (sortedAbs.length === 0) return 0;
  let lo = 0;
  let hi = sortedAbs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAbs[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo / sortedAbs.length;
}

/**
 * Human-facing "top N%" label for a percentile rank. `pct` is the fraction
 * of the table at or below this value, so `1 - pct` is the fraction above
 * it; the single largest value in the table has `pct === 1`, which would
 * otherwise print the misleading "top 0%" (reads as "beats nothing" when it
 * actually means "nothing in the table is bigger"). Clamped to at least 1.
 */
export function percentileLabel(pct: number): number {
  // Subtract a tiny epsilon before ceiling so float noise (e.g. 1 - 0.85 =
  // 0.15000000000000002) doesn't push an exact boundary up by one percent.
  return Math.max(1, Math.ceil((1 - pct) * 100 - 1e-9));
}

function roundNumberReason(absCents: number): { score: number; reason: string } | null {
  if (absCents > 0 && absCents % 100_000 === 0) {
    return { score: WEIGHTS.roundThousand, reason: `round number: multiple of $1,000 (${usd(absCents)})` };
  }
  if (absCents > 0 && absCents % 10_000 === 0) {
    return { score: WEIGHTS.roundHundred, reason: `round number: multiple of $100 (${usd(absCents)})` };
  }
  return null;
}

/**
 * First-seen date per (calendar year, key), using stable (date, id)
 * ordering so ties are deterministic. Scoped by year so "new counterparty"
 * means new *this year*, not merely new since the start of the table (a
 * vendor who last paid in a prior year should still flag as new in the
 * current one).
 */
export function firstSeenDatesByYear<T extends { id: number }>(
  rows: T[],
  dateOf: (row: T) => string,
  keyOf: (row: T) => string | null,
): Map<string, string> {
  const sorted = [...rows].sort((a, b) => {
    const da = dateOf(a);
    const db_ = dateOf(b);
    return da < db_ ? -1 : da > db_ ? 1 : a.id - b.id;
  });
  const firstSeen = new Map<string, string>();
  for (const row of sorted) {
    const key = keyOf(row);
    if (key === null) continue;
    const yearKey = `${yearOf(dateOf(row))}:${key}`;
    if (!firstSeen.has(yearKey)) firstSeen.set(yearKey, dateOf(row));
  }
  return firstSeen;
}

/** Composite (year, key) lookup key matching firstSeenDatesByYear's map. */
export function yearKey(date: string, key: string): string {
  return `${yearOf(date)}:${key}`;
}

export async function buildCandidates(): Promise<SampleCandidate[]> {
  const [bankRows, invoiceRows, dodoRows, priorFlagRows] = await Promise.all([
    db.select().from(schema.bankTransactions).orderBy(schema.bankTransactions.id),
    db.select().from(schema.invoices).orderBy(schema.invoices.id),
    db.select().from(schema.dodoTransactions).orderBy(schema.dodoTransactions.id),
    db
      .select({
        sampleType: schema.auditSamples.sampleType,
        sampleId: schema.auditSamples.sampleId,
      })
      .from(schema.auditSamples)
      .where(inArray(schema.auditSamples.status, ["gap", "conceded"])),
  ]);

  const priorFlagSet = new Set(priorFlagRows.map((f) => `${f.sampleType}:${f.sampleId}`));
  const candidates: SampleCandidate[] = [];

  // ---- bank_transactions ----
  const bankAbsSorted = bankRows.map((b) => Math.abs(toCents(b.amount))).sort((a, b) => a - b);
  const bankFirstSeen = firstSeenDatesByYear(bankRows, (b) => b.date, (b) => b.counterparty);
  for (const b of bankRows) {
    const cents = toCents(b.amount);
    const abs = Math.abs(cents);
    const reasons: string[] = [];
    let score = 0;

    const pct = percentileRank(bankAbsSorted, abs);
    if (pct >= LARGE_AMOUNT_PERCENTILE) {
      score += WEIGHTS.amount * pct;
      reasons.push(`large amount: ${usd(abs)} (top ${percentileLabel(pct)}% of bank_transactions by size)`);
    }

    const round = roundNumberReason(abs);
    if (round) {
      score += round.score;
      reasons.push(round.reason);
    }

    if (isMonthEnd(b.date)) {
      score += WEIGHTS.monthEnd;
      reasons.push(`month-end date: ${b.date}`);
    }

    if (bankFirstSeen.get(yearKey(b.date, b.counterparty)) === b.date) {
      score += WEIGHTS.newCounterparty;
      reasons.push(`new counterparty: first appearance of "${b.counterparty}" in ${yearOf(b.date)}`);
    }

    if (priorFlagSet.has(`bank_transaction:${b.id}`)) {
      score += WEIGHTS.priorFlag;
      reasons.push("prior flag: this record ended in a gap or was conceded in an earlier run");
    }

    candidates.push({
      sampleType: "bank_transaction",
      sampleId: b.id,
      amountCents: cents,
      date: b.date,
      riskScore: score,
      riskReasons: reasons,
    });
  }

  // ---- invoices ----
  const invoiceAbsSorted = invoiceRows.map((i) => Math.abs(toCents(i.amount))).sort((a, b) => a - b);
  const invoiceFirstSeen = firstSeenDatesByYear(invoiceRows, (i) => i.issueDate, (i) => String(i.vendorId));
  for (const i of invoiceRows) {
    const cents = toCents(i.amount);
    const abs = Math.abs(cents);
    const reasons: string[] = [];
    let score = 0;

    const pct = percentileRank(invoiceAbsSorted, abs);
    if (pct >= LARGE_AMOUNT_PERCENTILE) {
      score += WEIGHTS.amount * pct;
      reasons.push(`large amount: ${usd(abs)} (top ${percentileLabel(pct)}% of invoices by size)`);
    }

    const round = roundNumberReason(abs);
    if (round) {
      score += round.score;
      reasons.push(round.reason);
    }

    if (isMonthEnd(i.issueDate)) {
      score += WEIGHTS.monthEnd;
      reasons.push(`month-end date: ${i.issueDate}`);
    }

    if (invoiceFirstSeen.get(yearKey(i.issueDate, String(i.vendorId))) === i.issueDate) {
      score += WEIGHTS.newCounterparty;
      reasons.push(`new counterparty: first invoice in ${yearOf(i.issueDate)} from vendor #${i.vendorId}`);
    }

    if (priorFlagSet.has(`invoice:${i.id}`)) {
      score += WEIGHTS.priorFlag;
      reasons.push("prior flag: this record ended in a gap or was conceded in an earlier run");
    }

    candidates.push({
      sampleType: "invoice",
      sampleId: i.id,
      amountCents: cents,
      date: i.issueDate,
      riskScore: score,
      riskReasons: reasons,
    });
  }

  // ---- dodo_transactions ----
  const dodoAbsSorted = dodoRows.map((d) => Math.abs(toCents(d.amount))).sort((a, b) => a - b);
  const dodoFirstSeen = firstSeenDatesByYear(dodoRows, (d) => d.date, (d) => d.customerId);
  for (const d of dodoRows) {
    const cents = toCents(d.amount);
    const abs = Math.abs(cents);
    const reasons: string[] = [];
    let score = 0;

    const pct = percentileRank(dodoAbsSorted, abs);
    if (pct >= LARGE_AMOUNT_PERCENTILE) {
      score += WEIGHTS.amount * pct;
      reasons.push(`large amount: ${usd(abs)} (top ${percentileLabel(pct)}% of dodo_transactions by size)`);
    }

    const round = roundNumberReason(abs);
    if (round) {
      score += round.score;
      reasons.push(round.reason);
    }

    if (isMonthEnd(d.date)) {
      score += WEIGHTS.monthEnd;
      reasons.push(`month-end date: ${d.date}`);
    }

    if (d.customerId && dodoFirstSeen.get(yearKey(d.date, d.customerId)) === d.date) {
      score += WEIGHTS.newCounterparty;
      reasons.push(`new counterparty: first appearance of customer ${d.customerId} in ${yearOf(d.date)}`);
    }

    if (priorFlagSet.has(`dodo_transaction:${d.id}`)) {
      score += WEIGHTS.priorFlag;
      reasons.push("prior flag: this record ended in a gap or was conceded in an earlier run");
    }

    candidates.push({
      sampleType: "dodo_transaction",
      sampleId: d.id,
      amountCents: cents,
      date: d.date,
      riskScore: Math.round(score * 10_000) / 10_000,
      riskReasons: reasons,
    });
  }

  // Round every score the same way for a clean, comparable riskScore column.
  for (const c of candidates) c.riskScore = Math.round(c.riskScore * 10_000) / 10_000;

  return candidates;
}

/**
 * Weighted selection without replacement, deterministic given `seed`.
 * Every candidate keeps a small floor weight so low-risk records still have
 * a (tiny) chance of being sampled, matching real audit sampling practice.
 */
export function pickSamples(
  candidates: SampleCandidate[],
  seed: number,
  count = 25,
): SampleCandidate[] {
  const rng = new Rng(seed);
  const weights = candidates.map((c) => Math.max(c.riskScore, 0.02));
  const idx = weightedSampleIndices(rng, weights, Math.min(count, candidates.length));
  const picked = idx.map((i) => candidates[i]);
  // Stable display/storage order, independent of the internal sampling walk.
  return picked.sort(
    (a, b) => a.sampleType.localeCompare(b.sampleType) || a.sampleId - b.sampleId,
  );
}

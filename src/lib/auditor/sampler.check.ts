/**
 * pnpm auditor:check-sampler
 *
 * Deterministic focused checks for the sampler, covering the review fixes:
 *   1. percentileLabel() never renders the misleading "top 0%" (pure, no DB).
 *   2. firstSeenDatesByYear() scopes "new counterparty" to the calendar
 *      year: the same counterparty reappearing in a later year is flagged
 *      as new again (pure, synthetic multi-year data, no DB).
 *   3. Against real crossfire_b data: no candidate's risk_reasons contain
 *      "top 0%", and the same seed still produces exactly 25 unique picks,
 *      identically, across two independent calls (regression guard so the
 *      wording/scoping fixes above didn't change the sampling contract).
 *   4. Cycles and materiality, the two run inputs that shape the pool:
 *      selecting every cycle is a no-op over the candidate list, the four
 *      cycles partition it exactly, and materiality-first selection picks
 *      every record at or above it while leaving the risk-weighted draw with
 *      no forced picks bit-for-bit what it was before materiality existed.
 *      A materiality low enough to force more records than the target sample
 *      size returns all of them, with no risk-weighted fill: materiality
 *      outranks sample_size, which is the point of the input.
 *
 * Needs DATABASE_URL pointed at a seeded crossfire_b for check 3; checks 1
 * and 2 make no database calls.
 */
import "./load-env";
import { CYCLES } from "./cycles";
import { usd } from "./util";
import {
  filterByCycles,
  firstSeenDatesByYear,
  percentileLabel,
  pickSamples,
  yearKey,
} from "./sampler";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---- 1. percentileLabel never says "top 0%" ----
check("percentileLabel(1) (the single largest value) is not 0", percentileLabel(1) > 0, `got ${percentileLabel(1)}`);
check("percentileLabel(0.999) rounds up, not down to 0", percentileLabel(0.999) >= 1, `got ${percentileLabel(0.999)}`);
check(
  "percentileLabel(0.85) matches the large-amount threshold exactly (float-noise guarded)",
  percentileLabel(0.85) === 15,
  `got ${percentileLabel(0.85)}`,
);
check("percentileLabel(0) (smallest value) is 100", percentileLabel(0) === 100);

// ---- 2. firstSeenDatesByYear scopes by calendar year ----
{
  type Row = { id: number; date: string; counterparty: string };
  const rows: Row[] = [
    { id: 1, date: "2024-03-01", counterparty: "Acme Corp" },
    { id: 2, date: "2024-06-01", counterparty: "Acme Corp" }, // same year, not new
    { id: 3, date: "2025-01-15", counterparty: "Acme Corp" }, // new calendar year: should flag as new again
  ];
  const firstSeen = firstSeenDatesByYear(rows, (r) => r.date, (r) => r.counterparty);

  const row1IsNew = firstSeen.get(yearKey(rows[0].date, rows[0].counterparty)) === rows[0].date;
  const row2IsNew = firstSeen.get(yearKey(rows[1].date, rows[1].counterparty)) === rows[1].date;
  const row3IsNew = firstSeen.get(yearKey(rows[2].date, rows[2].counterparty)) === rows[2].date;

  check("2024-03-01 (first-ever appearance) flags as new", row1IsNew);
  check("2024-06-01 (same counterparty, same year) does not flag as new", !row2IsNew);
  check("2025-01-15 (same counterparty, new calendar year) flags as new again", row3IsNew);
}

// ---- 3. against real data ----
async function checkAgainstDatabase() {
  const { buildCandidates } = await import("./sampler");
  const candidates = await buildCandidates();
  check(`buildCandidates() returned candidates from a live database`, candidates.length > 0, `${candidates.length} candidates`);

  const misleading = candidates.filter((c) => c.riskReasons.some((r) => r.includes("top 0%")));
  check(`no candidate's risk_reasons contain the misleading "top 0%"`, misleading.length === 0, `${misleading.length} offending candidate(s)`);

  const seed = 424242;
  const picksA = pickSamples(candidates, seed, 25);
  const picksB = pickSamples(candidates, seed, 25);

  check("pickSamples returns exactly 25 picks", picksA.length === 25, `got ${picksA.length}`);
  const keysA = picksA.map((p) => `${p.sampleType}:${p.sampleId}`);
  check("all 25 picks are unique (no duplicate sample drawn twice)", new Set(keysA).size === keysA.length);

  const keysB = picksB.map((p) => `${p.sampleType}:${p.sampleId}`);
  const identical = keysA.length === keysB.length && keysA.every((k, i) => k === keysB[i]);
  check("same seed produces identical picks across two independent calls", identical);

  // ---- 4. cycles and materiality ----
  const all = filterByCycles(candidates, CYCLES);
  check(
    "selecting every cycle returns the candidate list unchanged, in order",
    all.length === candidates.length && all.every((c, i) => c === candidates[i]),
    `${all.length} of ${candidates.length}`,
  );

  const perCycle = CYCLES.map((cycle) => filterByCycles(candidates, [cycle]).length);
  check(
    "the four cycles partition the candidates with no overlap and nothing left out",
    perCycle.reduce((a, b) => a + b, 0) === candidates.length,
    CYCLES.map((c, i) => `${c}=${perCycle[i]}`).join(" "),
  );

  // $21,000: above every purchases record except invoice #5 and the bank
  // payment that settled it, so the forced set is small and known.
  const MATERIALITY = 2_100_000;
  const purchases = filterByCycles(candidates, ["purchases"]);
  const material = purchases.filter((c) => Math.abs(c.amountCents) >= MATERIALITY);
  const withMateriality = pickSamples(purchases, seed, 6, { materialityCents: MATERIALITY });
  const drawn = new Set(withMateriality.map((p) => `${p.sampleType}:${p.sampleId}`));
  check(
    "every candidate at or above materiality is sampled outright",
    material.length > 0 && material.every((c) => drawn.has(`${c.sampleType}:${c.sampleId}`)),
    `${material.length} above materiality, ${withMateriality.length} picks`,
  );

  const noForcedPicks = pickSamples(candidates, seed, 25, { materialityCents: Number.MAX_SAFE_INTEGER });
  const noForcedKeys = noForcedPicks.map((p) => `${p.sampleType}:${p.sampleId}`);
  check(
    "a materiality above every record leaves the risk-weighted draw untouched",
    noForcedKeys.length === keysA.length && noForcedKeys.every((k, i) => k === keysA[i]),
  );

  // Materiality outranks the target sample size on purpose: "every material
  // item is tested" is the whole reason the input exists, so a low materiality
  // is allowed to draw more than sample_size and the risk-weighted fill simply
  // has no slots left. Worth pinning down, because the consequence is that
  // such a run consists only of the cycles that hold material rows.
  const LOW_MATERIALITY = 1_000_000; // $10,000
  const overflowing = pickSamples(candidates, seed, 25, { materialityCents: LOW_MATERIALITY });
  const allMaterial = candidates.filter((c) => Math.abs(c.amountCents) >= LOW_MATERIALITY);
  const overflowKeys = new Set(overflowing.map((p) => `${p.sampleType}:${p.sampleId}`));
  check(
    "forced picks beyond the target sample size are all still returned",
    allMaterial.length > 25 &&
      overflowing.length === allMaterial.length &&
      allMaterial.every((c) => overflowKeys.has(`${c.sampleType}:${c.sampleId}`)),
    `${allMaterial.length} at or above ${usd(LOW_MATERIALITY)} against a target of 25, ${overflowing.length} picked`,
  );
  check(
    "when forced picks fill the run there is no risk-weighted fill left to add",
    overflowing.every((p) => Math.abs(p.amountCents) >= LOW_MATERIALITY),
    `cycles represented: ${[...new Set(overflowing.map((p) => p.cycle))].sort().join(", ")}`,
  );
}

checkAgainstDatabase()
  .then(async () => {
    const { sql } = await import("@/db");
    await sql.end();
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll sampler checks passed.");
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    const { sql } = await import("@/db");
    await sql.end().catch(() => {});
    process.exit(1);
  });

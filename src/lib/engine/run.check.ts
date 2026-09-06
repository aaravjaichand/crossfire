/**
 * pnpm engine:check
 *
 * Drives a whole run through the real engine against the seeded database with
 * the model turned off (CROSSFIRE_NO_LLM=1), so it is free, offline, and
 * repeatable, and it exercises exactly the fallback path a model outage would
 * take. Nothing here is mocked: prepareRun() draws the sample and runAudit()
 * takes every one of them through the accountant and the follow-up policy.
 *
 * The run is deliberately small and deliberately targeted. Materiality is set
 * just under the largest invoice in the books and the run is scoped to the
 * purchases cycle, which forces invoice #5 (billed 15% above its contract
 * rate) and the bank payment that settled it into the sample every time. That
 * planted issue raises rate_mismatch, which the policy escalates on sight, so
 * "a planted issue lands as a gap" is guaranteed by the inputs rather than by
 * a lucky seed.
 *
 * Asserts:
 *   1. Materiality forces every purchases-cycle record at or above it.
 *   2. The cycle filter holds: no payroll or revenue records in the sample.
 *   3. Every sample settles as defended or gap. Nothing is left open.
 *   4. Every accountant turn carries an evidence bundle with >= 1 citation.
 *   5. No sample runs past MAX_TURNS accountant turns.
 *   6. Every auditor turn carries a procedure.
 *   7. At least one planted issue (data/planted_issues.json) lands as a gap.
 *   8. The run finishes "complete" with progress equal to its sample count.
 *
 * Requires DATABASE_URL pointed at a seeded database; makes no network calls.
 */
import "@/lib/auditor/load-env";
import { readFileSync } from "node:fs";
import { asc, eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "@/db";
import { toCents, usd } from "@/lib/auditor/util";
import { prepareRun } from "./start";
import { MAX_TURNS, runAudit } from "./run";

// Read at call time by the accountant and the auditor, so setting it here —
// after the imports have been evaluated but before anything runs — is enough.
process.env.CROSSFIRE_NO_LLM = "1";

// Just under invoice #5 ($21,275.00, the planted over-contract-rate invoice)
// and its settling bank payment, and above every other purchases-cycle record.
const MATERIALITY_CENTS = 2_100_000;
const SAMPLE_SIZE = 6;
const SEED = 7;

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * The records the seed planted an issue on, read from the manifest rather than
 * hardcoded here, so a reseed can never leave this check asserting against
 * rows that moved.
 */
function plantedRecords(): Set<string> {
  const TABLE_TO_TYPE: Record<string, string> = {
    invoices: "invoice",
    bank_transactions: "bank_transaction",
    dodo_transactions: "dodo_transaction",
  };
  const manifest = JSON.parse(readFileSync("data/planted_issues.json", "utf8")) as {
    issues: { records: Record<string, { ids?: number[] }> }[];
  };
  const out = new Set<string>();
  for (const issue of manifest.issues) {
    for (const [table, record] of Object.entries(issue.records)) {
      const type = TABLE_TO_TYPE[table];
      if (!type || !Array.isArray(record?.ids)) continue;
      for (const id of record.ids) out.add(`${type}:${id}`);
    }
  }
  return out;
}

async function main() {
  const planted = plantedRecords();
  check(`read ${planted.size} planted records from data/planted_issues.json`, planted.size > 0);

  const started = await prepareRun({
    name: `Engine probe ${new Date().toISOString()}`,
    seed: SEED,
    materiality: MATERIALITY_CENTS,
    sampleSize: SAMPLE_SIZE,
    cycles: ["purchases"],
  });
  console.log(
    `\nRun #${started.runId}: ${started.sampleCount} samples, materiality ${usd(MATERIALITY_CENTS)}, ` +
      `cycles ${started.cycles.join(", ")}, model off.\n`,
  );

  const result = await runAudit(started.runId);
  console.log(
    `Loop finished: ${result.defended} defended, ${result.gaps} gap(s), ${result.failed} failed.\n`,
  );

  const samples = await db
    .select()
    .from(schema.auditSamples)
    .where(eq(schema.auditSamples.runId, started.runId))
    .orderBy(asc(schema.auditSamples.id));
  const exchanges = await db
    .select()
    .from(schema.auditExchanges)
    .where(eq(schema.auditExchanges.runId, started.runId))
    .orderBy(asc(schema.auditExchanges.sampleId), asc(schema.auditExchanges.turn));

  // ---- 1. materiality forces every record at or above it ----
  const invoicesAbove = (
    await db.select().from(schema.invoices)
  ).filter((i) => Math.abs(toCents(i.amount)) >= MATERIALITY_CENTS);
  const vendorNames = new Set((await db.select().from(schema.vendors)).map((v) => v.name));
  const bankAbove = (await db.select().from(schema.bankTransactions)).filter(
    (b) => Math.abs(toCents(b.amount)) >= MATERIALITY_CENTS && vendorNames.has(b.counterparty),
  );
  const drawn = new Set(samples.map((s) => `${s.sampleType}:${s.sampleId}`));
  const missedMaterial = [
    ...invoicesAbove.map((i) => `invoice:${i.id}`),
    ...bankAbove.map((b) => `bank_transaction:${b.id}`),
  ].filter((key) => !drawn.has(key));
  check(
    `every purchases record at or above ${usd(MATERIALITY_CENTS)} was sampled`,
    missedMaterial.length === 0,
    `${invoicesAbove.length + bankAbove.length} above materiality, ${missedMaterial.length} missed`,
  );

  // ---- 2. the cycle filter holds ----
  const bankSampleIds = samples.filter((s) => s.sampleType === "bank_transaction").map((s) => s.sampleId);
  const bankRows = bankSampleIds.length
    ? await db.select().from(schema.bankTransactions).where(inArray(schema.bankTransactions.id, bankSampleIds))
    : [];
  const offCycle = [
    ...samples.filter((s) => s.sampleType === "dodo_transaction").map((s) => `dodo:${s.sampleId}`),
    ...bankRows.filter((b) => !vendorNames.has(b.counterparty)).map((b) => `bank:${b.id} (${b.counterparty})`),
  ];
  check(
    "every sample belongs to the purchases cycle",
    offCycle.length === 0,
    offCycle.length ? offCycle.join(", ") : `${samples.length} samples`,
  );

  // ---- 3. nothing is left open ----
  const unsettled = samples.filter((s) => s.status !== "defended" && s.status !== "gap");
  check(
    "every sample ended defended or gap",
    unsettled.length === 0,
    unsettled.length
      ? unsettled.map((s) => `${s.sampleType}:${s.sampleId}=${s.status}`).join(", ")
      : `${samples.filter((s) => s.status === "defended").length} defended, ${samples.filter((s) => s.status === "gap").length} gap`,
  );

  // ---- 4. every accountant turn cites something ----
  const accountantTurns = exchanges.filter((e) => e.role === "accountant");
  const uncited = accountantTurns.filter((e) => !e.evidence || e.evidence.citations.length === 0);
  check(
    "every accountant turn carries an evidence bundle with at least one citation",
    accountantTurns.length > 0 && uncited.length === 0,
    `${accountantTurns.length} accountant turns, ${uncited.length} uncited`,
  );

  // ---- 5. the turn cap holds ----
  const turnsBySample = new Map<number, number>();
  for (const e of accountantTurns) {
    turnsBySample.set(e.sampleId, (turnsBySample.get(e.sampleId) ?? 0) + 1);
  }
  const overrun = [...turnsBySample.entries()].filter(([, n]) => n > MAX_TURNS);
  check(
    `no sample exceeded ${MAX_TURNS} accountant turns`,
    overrun.length === 0,
    `max observed ${Math.max(0, ...turnsBySample.values())}`,
  );

  // ---- 6. every auditor turn names its procedure ----
  const auditorTurns = exchanges.filter((e) => e.role === "auditor");
  const withoutProcedure = auditorTurns.filter((e) => !e.procedure);
  check(
    "every auditor turn carries a procedure",
    auditorTurns.length > 0 && withoutProcedure.length === 0,
    `${auditorTurns.length} auditor turns, ${new Set(auditorTurns.map((e) => e.procedure)).size} distinct procedures`,
  );

  // ---- 7. a planted issue lands as a gap ----
  const plantedGaps = samples.filter(
    (s) => s.status === "gap" && planted.has(`${s.sampleType}:${s.sampleId}`),
  );
  check(
    "at least one planted issue ended as a gap",
    plantedGaps.length > 0,
    plantedGaps.map((s) => `${s.sampleType}:${s.sampleId}`).join(", ") || "none",
  );

  // ---- 8. the run row reflects the finished run ----
  const [run] = await db.select().from(schema.auditRuns).where(eq(schema.auditRuns.id, started.runId));
  check(`run #${started.runId} finished "complete"`, run?.status === "complete", `status=${run?.status}`);
  check(
    "progress equals the sample count",
    run?.progress === samples.length,
    `progress=${run?.progress}, samples=${samples.length}`,
  );
  check(
    "the run stored the inputs it was drawn with",
    run?.seed === SEED &&
      run?.materiality === MATERIALITY_CENTS &&
      run?.sampleSize === SAMPLE_SIZE &&
      JSON.stringify(run?.cycles) === JSON.stringify(["purchases"]),
    `seed=${run?.seed} materiality=${run?.materiality} sampleSize=${run?.sampleSize} cycles=${JSON.stringify(run?.cycles)}`,
  );

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    await sql.end().catch(() => {});
    process.exit(1);
  }
  console.log("\nAll engine checks passed.");
  await sql.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});

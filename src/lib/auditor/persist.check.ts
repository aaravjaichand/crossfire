/**
 * pnpm auditor:check-persist
 *
 * Safe failure-oriented probe for persistRun()'s all-or-nothing transaction.
 * No LLM calls (question text is the deterministic template fallback, not
 * phrased): this only exercises the database transaction.
 *
 * 1. Injects a failure partway through a run (after 10 of 25 samples) and
 *    confirms the whole run — the audit_runs row included — rolls back to
 *    zero rows: no partial audit_samples/audit_exchanges survive.
 * 2. Runs the same prepared samples again with no injected failure and
 *    confirms all 25 samples and 25 turn-1 exchanges land under the new run.
 *
 * Requires DATABASE_URL to point at crossfire_b (or another disposable
 * database) and a seeded schema; makes no network calls.
 */
import "./load-env";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "@/db";
import { withSampleCitation } from "./citation";
import { loadSampleDetail } from "./detail";
import { persistRun, type PreparedSample } from "./persist";
import { chooseQuestion } from "./questions";
import { buildCandidates, pickSamples } from "./sampler";

const PROBE_SEED = 999_001; // distinct from any real run seed used elsewhere
const FAIL_AFTER = 10;
// Unique per invocation (Date.now()) so repeated runs of this probe never
// collide with a previous run's rows when checking "did this exact attempt
// leave anything behind".
const FAILING_RUN_NAME = `Atomicity probe (expected failure) ${Date.now()}`;
const SUCCESS_RUN_NAME = `Atomicity probe (expected success) ${Date.now()}`;

async function countRunRows(runId: number) {
  const samples = await db.select().from(schema.auditSamples).where(eq(schema.auditSamples.runId, runId));
  const exchanges = await db.select().from(schema.auditExchanges).where(eq(schema.auditExchanges.runId, runId));
  const [run] = await db.select().from(schema.auditRuns).where(eq(schema.auditRuns.id, runId));
  return { run, sampleCount: samples.length, exchangeCount: exchanges.length };
}

async function main() {
  let failures = 0;

  const candidates = await buildCandidates();
  const picks = pickSamples(candidates, PROBE_SEED, 25);
  const prepared: PreparedSample[] = [];
  for (const candidate of picks) {
    const detail = await loadSampleDetail(candidate);
    const { templateId, text } = chooseQuestion(candidate, detail);
    prepared.push({ candidate, templateId, question: withSampleCitation(text, candidate) });
  }
  console.log(`Prepared ${prepared.length} sample questions with no LLM calls (template fallback text).\n`);

  // ---- 1. injected failure rolls back completely ----
  try {
    await persistRun({
      name: FAILING_RUN_NAME,
      seed: PROBE_SEED,
      samples: prepared,
      failAfterSampleCount: FAIL_AFTER,
    });
    console.log("FAIL  expected persistRun() to throw on the injected failure, but it resolved.");
    failures++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isExpected = message.includes("[persist probe] simulated failure");
    console.log(`${isExpected ? "PASS" : "FAIL"}  persistRun() threw on the injected failure: ${message}`);
    if (!isExpected) failures++;
  }

  // The transaction rolled back before persistRun() could return a runId, so
  // look up this exact attempt by its unique name instead.
  const orphanRuns = await db.select().from(schema.auditRuns).where(eq(schema.auditRuns.name, FAILING_RUN_NAME));
  const rolledBackCleanly = orphanRuns.length === 0;
  console.log(
    `${rolledBackCleanly ? "PASS" : "FAIL"}  no audit_runs row survived the rollback (found ${orphanRuns.length})`,
  );
  if (!rolledBackCleanly) failures++;

  if (orphanRuns.length > 0) {
    const { sampleCount, exchangeCount } = await countRunRows(orphanRuns[0].id);
    const noPartialRows = sampleCount === 0 && exchangeCount === 0;
    console.log(
      `${noPartialRows ? "PASS" : "FAIL"}  no partial audit_samples/audit_exchanges rows for the failed run (samples=${sampleCount}, exchanges=${exchangeCount})`,
    );
    if (!noPartialRows) failures++;
  }

  // ---- 2. a clean run (no injected failure) persists every row ----
  const { runId } = await persistRun({
    name: SUCCESS_RUN_NAME,
    seed: PROBE_SEED,
    samples: prepared,
  });
  const { run, sampleCount, exchangeCount } = await countRunRows(runId);
  const complete = run?.status === "complete";
  const allSamples = sampleCount === prepared.length;
  const allExchanges = exchangeCount === prepared.length;
  console.log(
    `${complete ? "PASS" : "FAIL"}  successful run #${runId} has status "complete" (actual: "${run?.status}")`,
  );
  console.log(
    `${allSamples ? "PASS" : "FAIL"}  successful run #${runId} has all ${prepared.length} audit_samples rows (actual: ${sampleCount})`,
  );
  console.log(
    `${allExchanges ? "PASS" : "FAIL"}  successful run #${runId} has all ${prepared.length} turn-1 audit_exchanges rows (actual: ${exchangeCount})`,
  );
  if (!complete) failures++;
  if (!allSamples) failures++;
  if (!allExchanges) failures++;

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    await sql.end().catch(() => {});
    process.exit(1);
  }
  console.log("\nAll atomicity probe checks passed.");
  await sql.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});

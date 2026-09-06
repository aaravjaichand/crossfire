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
 *   9. Bounded stepping: runAuditStep() honours its sample quota, leaves the
 *      run "running" while work remains, and repeated calls drive it to
 *      "complete" with progress ending exactly at the sample count.
 *  10. Idempotency: three runAuditStep() calls racing on one run settle every
 *      sample exactly once. No sample is worked twice.
 *  11. A model that errors on every call still finishes the run, on the
 *      deterministic defense, with the reason recorded as provenance.
 *  12. No accountant paragraph opens by talking about itself.
 *
 * Requires DATABASE_URL pointed at a seeded database; makes no network calls
 * (the model is turned off, and the failure case is injected rather than
 * dialled).
 */
import "@/lib/auditor/load-env";
import { readFileSync } from "node:fs";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "@/db";
import { toCents, usd } from "@/lib/auditor/util";
import { prepareRun } from "./start";
import { MAX_TURNS, runAudit, runAuditStep } from "./run";

// Read at call time by the accountant and the auditor, so setting it here —
// after the imports have been evaluated but before anything runs — is enough.
process.env.CROSSFIRE_NO_LLM = "1";

// Just under invoice #5 ($21,275.00, the planted over-contract-rate invoice)
// and its settling bank payment, and above every other purchases-cycle record.
const MATERIALITY_CENTS = 2_100_000;
const SAMPLE_SIZE = 6;
const SEED = 7;

/**
 * Runs created by this invocation. Assertions about prose or turns are scoped
 * to these: the database keeps every earlier run, and a check that swept them
 * all would be asserting against history rather than against this code.
 */
const probeRunIds: number[] = [];

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
  probeRunIds.push(started.runId);
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

  await checkStepping();
  await checkConcurrentSteps();
  await checkModelFailureFallback();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    await sql.end().catch(() => {});
    process.exit(1);
  }
  console.log("\nAll engine checks passed.");
  await sql.end();
  process.exit(0);
}

/**
 * 9. Bounded stepping. The run is worked in slices of at most STEP_SAMPLES
 * samples, the way a client on a host that kills long requests would have to
 * drive it, and has to arrive at exactly the same finished state.
 */
async function checkStepping() {
  const STEP_SAMPLES = 3;
  const started = await prepareRun({
    name: `Engine stepping probe ${new Date().toISOString()}`,
    seed: 11,
    materiality: MATERIALITY_CENTS,
    sampleSize: 8,
    cycles: ["purchases"],
  });
  probeRunIds.push(started.runId);
  console.log(`\nStepping run #${started.runId}: ${started.sampleCount} samples, ${STEP_SAMPLES} per step.`);

  const progressSeen: number[] = [];
  const settledPerStep: number[] = [];
  const statusesWhileWorking: string[] = [];
  let steps = 0;
  let last;
  do {
    last = await runAuditStep(started.runId, { maxSamples: STEP_SAMPLES, concurrency: 2 });
    steps++;
    progressSeen.push(last.progress);
    settledPerStep.push(last.settled);
    if (!last.done) statusesWhileWorking.push(last.status);
  } while (!last.done && steps < 10);

  check(
    `no step settled more than its quota of ${STEP_SAMPLES}`,
    settledPerStep.every((n) => n <= STEP_SAMPLES),
    `settled per step: ${settledPerStep.join(", ")}`,
  );
  check(
    "more than one step was needed, so stepping was actually exercised",
    steps > 1,
    `${steps} steps for ${started.sampleCount} samples`,
  );
  check(
    'the run reported "running" while samples were still open',
    statusesWhileWorking.every((st) => st === "running"),
    statusesWhileWorking.join(", ") || "(finished in one step)",
  );
  check(
    "progress never went backwards",
    progressSeen.every((n, i) => i === 0 || n >= progressSeen[i - 1]),
    progressSeen.join(" -> "),
  );
  check(
    'the last step reported done and "complete"',
    last.done && last.status === "complete",
    `done=${last.done} status=${last.status}`,
  );
  check(
    "stepping ended with progress exactly at the sample count",
    last.progress === last.sampleCount && last.sampleCount === started.sampleCount,
    `progress=${last.progress} sampleCount=${last.sampleCount}`,
  );

  const stepped = await db
    .select()
    .from(schema.auditSamples)
    .where(eq(schema.auditSamples.runId, started.runId));
  check(
    "every stepped sample settled and released its claim",
    stepped.every((s) => s.status !== "open" && s.claimedAt === null),
    `${stepped.filter((s) => s.claimedAt !== null).length} still claimed`,
  );
}

/**
 * 10. The property the advance route depends on: overlapping callers divide
 * the samples instead of duplicating them. Three steps race on one run with a
 * single worker each — enough to contend on every claim, few enough to stay
 * well inside the database pool (max 5), since the point is correctness under
 * contention rather than throughput.
 */
async function checkConcurrentSteps() {
  const started = await prepareRun({
    name: `Engine concurrency probe ${new Date().toISOString()}`,
    seed: 13,
    materiality: MATERIALITY_CENTS,
    sampleSize: 6,
    cycles: ["purchases"],
  });
  probeRunIds.push(started.runId);
  console.log(`\nConcurrency run #${started.runId}: ${started.sampleCount} samples, 3 racing steps.`);

  const results = await Promise.all([
    runAuditStep(started.runId, { maxSamples: 6, concurrency: 1 }),
    runAuditStep(started.runId, { maxSamples: 6, concurrency: 1 }),
    runAuditStep(started.runId, { maxSamples: 6, concurrency: 1 }),
  ]);

  const settledTotal = results.reduce((sum, r) => sum + r.settled, 0);
  check(
    "three racing steps settled each sample exactly once between them",
    settledTotal === started.sampleCount,
    `${settledTotal} settled across steps, ${started.sampleCount} samples (${results.map((r) => r.settled).join("+")})`,
  );

  // The load-bearing assertion: a sample worked twice would answer its opening
  // question twice, so it would carry two accountant turns on turn 1.
  const rows = await db
    .select()
    .from(schema.auditExchanges)
    .where(eq(schema.auditExchanges.runId, started.runId));
  const firstAnswers = new Map<number, number>();
  for (const e of rows) {
    if (e.role !== "accountant" || e.turn !== 1) continue;
    firstAnswers.set(e.sampleId, (firstAnswers.get(e.sampleId) ?? 0) + 1);
  }
  const doubled = [...firstAnswers.entries()].filter(([, n]) => n > 1);
  check(
    "no sample was answered twice on turn 1 (no double processing)",
    firstAnswers.size === started.sampleCount && doubled.length === 0,
    `${firstAnswers.size} samples answered, ${doubled.length} answered more than once`,
  );

  const [run] = await db.select().from(schema.auditRuns).where(eq(schema.auditRuns.id, started.runId));
  check(
    "the racing steps agreed on the final run state",
    run?.status === "complete" && run?.progress === started.sampleCount,
    `status=${run?.status} progress=${run?.progress}/${started.sampleCount}`,
  );
}

/**
 * 11 and 12. Every model call fails, and the run still finishes. The failure
 * is injected (CROSSFIRE_LLM_FAIL) rather than dialled at a real endpoint with
 * a bad key: same catch branch, but offline, instant and deterministic instead
 * of hostage to a 30 second client timeout. The real-client path was confirmed
 * separately by a live run against a stale key.
 */
async function checkModelFailureFallback() {
  delete process.env.CROSSFIRE_NO_LLM;
  process.env.CROSSFIRE_LLM_FAIL = "1";
  try {
    const started = await prepareRun({
      name: `Engine model-failure probe ${new Date().toISOString()}`,
      seed: 17,
      materiality: MATERIALITY_CENTS,
      sampleSize: 3,
      cycles: ["purchases"],
    });
    probeRunIds.push(started.runId);
    console.log(`\nModel-failure run #${started.runId}: ${started.sampleCount} samples, every model call throws.`);

    const result = await runAudit(started.runId);
    check(
      "a model that fails on every call does not fail the run",
      result.failed === 0 && result.processed === started.sampleCount,
      `${result.processed} processed, ${result.failed} failed`,
    );

    const samples = await db
      .select()
      .from(schema.auditSamples)
      .where(eq(schema.auditSamples.runId, started.runId));
    check(
      "every sample still settled",
      samples.every((s) => s.status === "defended" || s.status === "gap"),
      samples.map((s) => s.status).join(", "),
    );

    const turns = await db
      .select()
      .from(schema.auditExchanges)
      .where(eq(schema.auditExchanges.runId, started.runId));
    const accountant = turns.filter((e) => e.role === "accountant");
    const attributed = accountant.filter(
      (e) => e.evidence?.defenseSource?.source === "fallback" && Boolean(e.evidence.defenseSource.reason),
    );
    check(
      "every defense is recorded as a fallback, with the reason",
      accountant.length > 0 && attributed.length === accountant.length,
      `${attributed.length} of ${accountant.length}; reason: ${accountant[0]?.evidence?.defenseSource?.reason ?? "(none)"}`,
    );
    check(
      "the fallback prose still cites rows",
      accountant.every((e) => /\[[a-z_]+#\d+\]/.test(e.content)),
    );

    // 12. Provenance belongs beside the prose, not at the front of it. Scoped
    // to this invocation's runs: rows written before this change still open
    // with the old preamble, and that is history, not a regression.
    const written = await db
      .select({ content: schema.auditExchanges.content })
      .from(schema.auditExchanges)
      .where(
        and(
          inArray(schema.auditExchanges.runId, probeRunIds),
          eq(schema.auditExchanges.role, "accountant"),
        ),
      );
    const selfReferential = written.filter((e) =>
      /^(This response is|This answer is|The model )/.test(e.content.trim()),
    );
    check(
      "no accountant paragraph opens by talking about itself or the model",
      written.length > 0 && selfReferential.length === 0,
      selfReferential.length
        ? `e.g. "${selfReferential[0].content.slice(0, 80)}..."`
        : `checked ${written.length} accountant turns across ${probeRunIds.length} runs`,
    );
  } finally {
    delete process.env.CROSSFIRE_LLM_FAIL;
    process.env.CROSSFIRE_NO_LLM = "1";
  }
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});

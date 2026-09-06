/**
 * pnpm memory:check
 *
 * Proves the whole memory loop end to end against the seeded database, with
 * the model turned off (CROSSFIRE_NO_LLM=1) so it is free, offline and
 * repeatable. Nothing is mocked: two real runs are driven through the real
 * engine, and the rulings between them are filed through the referee's own
 * recordDecision(), the same path the controller's buttons use.
 *
 *   run 1   Same inputs as engine:check — materiality just under invoice #5
 *           (billed 15% over its contract rate) scoped to purchases, so the
 *           planted issues land as gaps whatever the seed does.
 *   ruling  The controller accepts one gap with a note, and sends another back
 *           with a note saying where to look. Both are filed in learned_rules
 *           by the referee, under the counterparty and the gap kind.
 *   run 2   Same seed, same inputs, so the same rows are sampled again. The
 *           accepted ruling now settles its sample without troubling the
 *           controller, and the coverage score rises.
 *
 * Asserts:
 *   1. Run 1 produces gaps for the controller to rule on.
 *   2. Filing the rulings writes learned_rules rows.
 *   3. The counterparty this module looks a rule up by is the string the
 *      referee filed it under — the round trip, not the two endpoints.
 *   4. A run never reads its own rules, and never reads a fixture run's.
 *   5. An exception rule is not carried forward.
 *   6. Run 2 settles the accepted sample by memory: status defended,
 *      resolution "memory", one more accountant turn quoting the ruling and
 *      citing learned_rules and the row under audit.
 *   7. That turn survives the referee's evidence parser, so the run screen and
 *      the binder can read it.
 *   8. The "needs more" note reached the second run's search context, and the
 *      rule it came from is cited on the defense written with it.
 *   9. Run 2's coverage score is higher than run 1's.
 *
 * Requires DATABASE_URL pointed at a seeded database; makes no network calls.
 */
import "@/lib/auditor/load-env";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  loadSampleMemory,
  memoryResolvedIds,
  memorySearchNotes,
  MEMORY_RESOLUTION,
  type LearnedRule,
} from "@/lib/accountant/memory";
import type { SampleRef, SampleType } from "@/lib/accountant/types";
import { parseEvidenceBundle } from "@/lib/referee/parse-evidence";
import { recordDecision } from "@/lib/referee/decide";
import { formatSampleId } from "@/lib/referee/sample-id";
import { prepareRun } from "./start";
import { runAudit } from "./run";

process.env.CROSSFIRE_NO_LLM = "1";

// The same targeted inputs engine:check uses: invoice #5 and the bank payment
// that settled it are forced into every run, so run 1 always has gaps.
const MATERIALITY_CENTS = 2_100_000;
const SAMPLE_SIZE = 6;
const SEED = 1;

const RUN_NAME_PREFIX = "Memory check,";
const MOCK_NOTE = "Ruled on the walkthrough fixture, which is not the books.";

const ACCEPT_NOTE =
  "Reviewed with the vendor: the uplift is the agreed 2025 rate change and the difference is below the threshold worth pursuing. Do not raise this again.";
const NEEDS_MORE_NOTE =
  "Check the contract amendment folder and the ledger accrual for this vendor before calling it unsupported.";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

type SampleRow = typeof schema.auditSamples.$inferSelect;

async function samplesOf(runId: number): Promise<SampleRow[]> {
  return db
    .select()
    .from(schema.auditSamples)
    .where(eq(schema.auditSamples.runId, runId))
    .orderBy(asc(schema.auditSamples.id));
}

function coverageOf(samples: SampleRow[]): number {
  const defended = samples.filter((s) => s.status === "defended").length;
  return samples.length === 0 ? 0 : Math.round((defended / samples.length) * 100);
}

function refOf(sample: SampleRow): SampleRef {
  return { type: sample.sampleType as SampleType, id: sample.sampleId };
}

async function exchangesOf(auditSampleId: number) {
  return db
    .select()
    .from(schema.auditExchanges)
    .where(eq(schema.auditExchanges.sampleId, auditSampleId))
    .orderBy(asc(schema.auditExchanges.turn), asc(schema.auditExchanges.id));
}

async function rulesOf(runId: number): Promise<(typeof schema.learnedRules.$inferSelect)[]> {
  return db
    .select()
    .from(schema.learnedRules)
    .where(eq(schema.learnedRules.runId, String(runId)))
    .orderBy(asc(schema.learnedRules.id));
}

/**
 * This check has to leave the database exactly as it found it, in both
 * directions.
 *
 * Its rulings are memory: left behind, they would settle the first run of the
 * next invocation before it has anything to learn, and they would change what
 * every other check's runs — and the demo's — see in the books. Its runs are
 * the two most recent ones, which is precisely what the home page comparison
 * panel reads, so leaving them would put a check run at the top of the screen.
 *
 * So everything it writes is removed: its runs (found by name), their samples,
 * threads, rulings and rules, and the single rule it files under the
 * walkthrough key (found by its note). Called at the end, and again at the
 * start in case a previous invocation was interrupted before it got there.
 */
async function cleanupCheckRuns(): Promise<number> {
  const prior = await db
    .select({ id: schema.auditRuns.id })
    .from(schema.auditRuns)
    .where(like(schema.auditRuns.name, `${RUN_NAME_PREFIX}%`));
  const ids = prior.map((r) => r.id);
  const keys = ids.map(String);

  if (ids.length > 0) {
    await db.delete(schema.auditExchanges).where(inArray(schema.auditExchanges.runId, ids));
    await db.delete(schema.auditSamples).where(inArray(schema.auditSamples.runId, ids));
    await db.delete(schema.learnedRules).where(inArray(schema.learnedRules.runId, keys));
    await db.delete(schema.refereeDecisions).where(inArray(schema.refereeDecisions.runId, keys));
    await db.delete(schema.auditRuns).where(inArray(schema.auditRuns.id, ids));
  }
  await db
    .delete(schema.learnedRules)
    .where(and(eq(schema.learnedRules.runId, "mock"), eq(schema.learnedRules.note, MOCK_NOTE)));
  return ids.length;
}

/**
 * Rulings filed by earlier runs — the demo's, another check's — are memory too,
 * and run 1 would honour them. On a database that has been used, that is what
 * happens: a rule already on file settles the very samples run 1 needs to leave
 * as gaps, run 1 opens with nothing for the controller to rule on, and the
 * check cannot start. The pass/fail then depends on what happens to be in the
 * table, which is not a check.
 *
 * So the check gives itself an empty memory to start from, the same way it
 * gives itself its own runs. Parking is a rename, not a delete: prefixing the
 * run key makes a rule fail loadSampleMemory's "numeric run keys only" filter,
 * so the engine cannot see it, and unparking puts every row back exactly as it
 * was. Nothing is destroyed, so an interrupted run costs the database its
 * memory until the next invocation, which unparks before it does anything else.
 *
 * The check's own rules are filed while parking is in force and under numeric
 * keys of its own, so they are visible to run 2 and are cleaned up by name.
 */
const PARK_PREFIX = "parked-by-memory-check:";

async function parkPriorRules(): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    update learned_rules
       set run_id = ${PARK_PREFIX} || run_id
     where run_id ~ '^[0-9]+$'
    returning id
  `);
  return rows.length;
}

async function unparkPriorRules(): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    update learned_rules
       set run_id = replace(run_id, ${PARK_PREFIX}, '')
     where run_id like ${`${PARK_PREFIX}%`}
    returning id
  `);
  return rows.length;
}

/** Thrown when a precondition fails and the assertions below cannot mean anything. */
class Bail extends Error {}

async function runChecks() {
  // ---------- run 1 ----------
  const first = await prepareRun({
    name: "Memory check, run 1",
    seed: SEED,
    materiality: MATERIALITY_CENTS,
    sampleSize: SAMPLE_SIZE,
    cycles: ["purchases"],
  });
  const firstResult = await runAudit(first.runId);
  const firstSamples = await samplesOf(first.runId);
  const firstGaps = firstSamples.filter((s) => s.status === "gap");

  check(
    "run 1 settled every sample and left gaps for the controller",
    firstResult.failed === 0 && firstGaps.length >= 2,
    `${firstResult.defended} defended, ${firstGaps.length} gaps, ${firstResult.failed} failed`,
  );
  check(
    "run 1 resolved nothing by memory: there is nothing to remember yet",
    firstResult.resolvedByMemory === 0,
    `${firstResult.resolvedByMemory} resolved by memory`,
  );
  if (firstGaps.length < 2) throw new Bail("Cannot continue without two gaps to rule on.");

  const accepted = firstGaps[0];
  const sentBack = firstGaps[1];
  const raised = firstGaps[2];

  // ---------- the controller rules ----------
  const acceptResult = await recordDecision(
    { runId: String(first.runId), sampleType: accepted.sampleType, sampleId: accepted.sampleId },
    "accepted_with_note",
    { note: ACCEPT_NOTE },
  );
  const needsMoreResult = await recordDecision(
    { runId: String(first.runId), sampleType: sentBack.sampleType, sampleId: sentBack.sampleId },
    "needs_more",
    { note: NEEDS_MORE_NOTE },
  );
  const exceptionResult = raised
    ? await recordDecision(
        { runId: String(first.runId), sampleType: raised.sampleType, sampleId: raised.sampleId },
        "exception",
        { note: "Recovered from the vendor.", remedy: "recover_cash" },
      )
    : { ok: true as const, runKey: String(first.runId) };

  check(
    "the controller's rulings were recorded",
    acceptResult.ok && needsMoreResult.ok && exceptionResult.ok,
    [acceptResult, needsMoreResult, exceptionResult]
      .map((r) => (r.ok ? "ok" : r.message))
      .join(", "),
  );

  const rules = await rulesOf(first.runId);
  const acceptRule = rules.find((r) => r.verdict === "accepted_with_note");
  const needsMoreRule = rules.find((r) => r.verdict === "needs_more");
  check(
    "each ruling that carries judgement wrote a learned_rules row",
    Boolean(acceptRule) && Boolean(needsMoreRule),
    `${rules.length} rules: ${rules.map((r) => `#${r.id} ${r.verdict}/${r.gapKind}`).join(", ")}`,
  );
  if (!acceptRule || !needsMoreRule) throw new Bail("Cannot continue without the two rules.");

  // ---------- the round trip ----------
  // The one thing that can fail silently: the referee files a rule under a
  // counterparty string built from the sample's label, and this module looks
  // it up from the sample's row facts. If those two derivations ever disagree
  // nothing matches and memory quietly does nothing, so the check asserts the
  // rule comes back by id rather than asserting the two strings separately.
  // Two rules that must never be used, filed straight into the table so they
  // are on file before run 2 starts: if either filter were wrong, run 2 would
  // read them and the assertions below would see it.
  const [plantedException] = await db
    .insert(schema.learnedRules)
    .values({
      runId: String(first.runId),
      sampleType: accepted.sampleType,
      sampleId: accepted.sampleId,
      gapKind: acceptRule.gapKind,
      counterparty: acceptRule.counterparty,
      remedy: "recover_cash",
      note: "A finding, not a licence to close the next one like it.",
      verdict: "exception",
    })
    .returning();
  const [plantedMockRule] = await db
    .insert(schema.learnedRules)
    .values({
      runId: "mock",
      sampleType: accepted.sampleType,
      sampleId: accepted.sampleId,
      gapKind: acceptRule.gapKind,
      counterparty: acceptRule.counterparty,
      note: MOCK_NOTE,
      verdict: "accepted_with_note",
    })
    .returning();

  const memory = await loadSampleMemory(refOf(accepted), { runId: first.runId + 1_000_000 });
  check(
    "the rule the referee filed is the rule memory reads back",
    memory.rules.some((r) => r.id === acceptRule.id),
    `counterparty "${memory.counterparty}" vs filed "${acceptRule.counterparty}", ${memory.rules.length} rules found`,
  );
  check(
    "an exception rule is never carried forward",
    memory.rules.every((r: LearnedRule) => r.id !== plantedException.id),
    `learned_rules#${plantedException.id} (exception on the same counterparty and gap kind) is not among the ${memory.rules.length} usable rules`,
  );

  const ownMemory = await loadSampleMemory(refOf(accepted), { runId: first.runId });
  check(
    "a run never reads its own rules",
    ownMemory.rules.every((r) => r.runId !== String(first.runId)),
    `${ownMemory.rules.length} rules visible to run ${first.runId} itself`,
  );

  check(
    "rules filed by the walkthrough run are never read into a real run",
    memory.rules.every((r) => r.id !== plantedMockRule.id && /^\d+$/.test(r.runId)),
    `learned_rules#${plantedMockRule.id} is filed under "mock" and is not among the ${memory.rules.length} usable rules`,
  );

  const notes = memorySearchNotes(memory);
  check(
    "the needs-more note is what memory hands to the next search",
    notes.some((n) => n.includes(NEEDS_MORE_NOTE)),
    notes.length === 0 ? "no search notes" : `${notes.length} note(s)`,
  );

  // ---------- run 2 ----------
  const second = await prepareRun({
    name: "Memory check, run 2",
    seed: SEED,
    materiality: MATERIALITY_CENTS,
    sampleSize: SAMPLE_SIZE,
    cycles: ["purchases"],
  });
  const secondResult = await runAudit(second.runId);
  const secondSamples = await samplesOf(second.runId);

  check(
    "run 2 drew the same rows as run 1",
    firstSamples.map((s) => `${s.sampleType}:${s.sampleId}`).sort().join(",") ===
      secondSamples.map((s) => `${s.sampleType}:${s.sampleId}`).sort().join(","),
    `${secondSamples.length} samples`,
  );

  const resolvedSample = secondSamples.find(
    (s) => s.sampleType === accepted.sampleType && s.sampleId === accepted.sampleId,
  );
  check(
    "the sample the controller accepted is settled by memory in run 2",
    Boolean(resolvedSample) &&
      resolvedSample!.status === "defended" &&
      resolvedSample!.resolution === MEMORY_RESOLUTION,
    resolvedSample
      ? `${resolvedSample.sampleType}:${resolvedSample.sampleId} status=${resolvedSample.status} resolution=${resolvedSample.resolution}`
      : "sample not drawn again",
  );
  check(
    "the run reports it, and only the samples memory settled",
    secondResult.resolvedByMemory ===
      secondSamples.filter((s) => s.resolution === MEMORY_RESOLUTION).length &&
      secondResult.resolvedByMemory >= 1,
    `${secondResult.resolvedByMemory} resolved by memory`,
  );

  const ids = await memoryResolvedIds(String(second.runId));
  check(
    "the run screen can read which samples those were, keyed the way it keys samples",
    ids.has(formatSampleId(refOf(accepted))),
    `[${[...ids].join(", ")}]`,
  );

  const resolvedThread = await exchangesOf(resolvedSample!.id);
  const memoryTurn = resolvedThread[resolvedThread.length - 1];
  const bundle = parseEvidenceBundle(memoryTurn?.evidence);
  const citesRule = bundle?.citations.some(
    (c) => c.table === "learned_rules" && c.id === acceptRule.id,
  );
  const citesSample = bundle?.citations.some(
    (c) => c.id === accepted.sampleId && c.table !== "learned_rules",
  );
  check(
    "the memory turn quotes the controller's note",
    memoryTurn?.role === "accountant" && memoryTurn.content.includes(ACCEPT_NOTE),
    memoryTurn ? `turn ${memoryTurn.turn}, role ${memoryTurn.role}` : "no turn written",
  );
  check(
    "it cites the learned rule and the row under audit, and admits no gap",
    Boolean(citesRule) && Boolean(citesSample) && bundle?.gaps.length === 0,
    bundle
      ? `citations: ${bundle.citations.map((c) => `${c.table}#${c.id}`).join(", ")}`
      : "the referee's parser dropped the bundle",
  );
  check(
    "the gap it disposes of is still on the record on the turn before it",
    resolvedThread
      .slice(0, -1)
      .some((e) => (parseEvidenceBundle(e.evidence)?.gaps.length ?? 0) > 0),
    `${resolvedThread.length} turns on the thread`,
  );

  // ---------- the needs-more note reached the second run ----------
  const sentBackAgain = secondSamples.find(
    (s) => s.sampleType === sentBack.sampleType && s.sampleId === sentBack.sampleId,
  );
  const sentBackThread = sentBackAgain ? await exchangesOf(sentBackAgain.id) : [];
  const citedNeedsMore = sentBackThread.some((e) =>
    parseEvidenceBundle(e.evidence)?.citations.some(
      (c) => c.table === "learned_rules" && c.id === needsMoreRule.id,
    ),
  );
  check(
    "the defense written with the controller's note cites the note it was written with",
    citedNeedsMore,
    sentBackAgain
      ? `${sentBackAgain.sampleType}:${sentBackAgain.sampleId}, ${sentBackThread.length} turns`
      : "sample not drawn again",
  );

  // ---------- the finish line ----------
  const beforeRulings = coverageOf(firstSamples);
  const firstCoverage = coverageOf(await samplesOf(first.runId));
  const secondCoverage = coverageOf(secondSamples);
  check(
    "run 2 scores higher coverage than run 1",
    secondCoverage > firstCoverage,
    `run ${first.runId}: ${beforeRulings}% as the engine left it, ${firstCoverage}% after the controller ruled -> run ${second.runId}: ${secondCoverage}%`,
  );

  // Everything asserted above has been read; the runs and the rulings this
  // check invented go away so the next run of anything sees the books as they
  // were.
  const removed = await cleanupCheckRuns();
  check(
    "the check leaves no runs and no rulings of its own behind",
    removed === 2 && (await rulesOf(first.runId)).length === 0,
    `${removed} runs removed`,
  );
}

async function main() {
  // Before anything else, in case a previous invocation died between parking
  // and restoring.
  const recovered = await unparkPriorRules();
  if (recovered > 0) {
    console.log(`(restored ${recovered} rule${recovered === 1 ? "" : "s"} left parked by an interrupted check)`);
  }
  const cleared = await cleanupCheckRuns();
  if (cleared > 0) {
    console.log(`(removed ${cleared} run${cleared === 1 ? "" : "s"} left by an interrupted check)`);
  }

  const parked = await parkPriorRules();
  if (parked > 0) {
    console.log(
      `(set ${parked} rule${parked === 1 ? "" : "s"} from earlier runs aside, so run 1 starts with an empty memory)`,
    );
  }
  if (recovered > 0 || cleared > 0 || parked > 0) console.log("");

  try {
    await runChecks();
  } catch (err) {
    if (!(err instanceof Bail)) throw err;
    failures++;
    console.log(`\n${err.message}`);
  } finally {
    await cleanupCheckRuns();
    const restored = await unparkPriorRules();
    check(
      "the rules it set aside are back on file, exactly as many as it parked",
      restored === parked,
      `${parked} parked, ${restored} restored`,
    );
  }

  console.log(
    `\n${failures === 0 ? "All" : "Some"} memory checks ran: ${failures} failure${failures === 1 ? "" : "s"}.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  // Never leave the database without its memory because of a crash.
  await unparkPriorRules().catch(() => {});
  process.exit(1);
});

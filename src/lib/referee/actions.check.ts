/**
 * pnpm referee:check-actions
 *
 * Proves the controller's four verdicts against a seeded database:
 *   1. sufficient / needs_more / exception / accepted_with_note each insert a
 *      referee_decisions row and move audit_samples.status to
 *      defended / open / gap / defended in the same transaction.
 *   2. needs_more sets audit_samples.pending_follow_up to the note for the
 *      engine to pick up, and every other verdict clears it.
 *   3. learned_rules gets one row per ruling that carries judgement, with the
 *      gap kind, counterparty, remedy, and verdict filled in — and none at all
 *      for a sufficient verdict.
 *   4. A verdict missing its required note or remedy is refused, and nothing
 *      is written.
 *   5. A sample that is not in the named run, and a run that does not exist,
 *      are rejected without writing anything.
 *   6. Mock rulings are filed under "mock" and survive a fresh read, since
 *      nothing is cached in the process.
 *   7. Failures come back as a result the UI can render, not as a thrown
 *      database error.
 *
 * Creates a throwaway audit run and deletes it again, so it can be re-run.
 */
import "./load-env";
import { and, desc, eq, gt } from "drizzle-orm";
import { db, schema } from "@/db";
import { recordDecision, type DecisionInput, type DecisionResult } from "./decide";
import { getRun } from "./data";
import { loadDecisions } from "./decisions";
import { MOCK_RUN_ID } from "./mock-run";
import type { Remedy, Verdict } from "./verdicts";

// actions.ts is a "use server" wrapper that adds revalidatePath around this
// same core, which cannot run outside a Next request.
const rule = (
  input: DecisionInput,
  verdict: Verdict,
  detail: { note?: string; remedy?: Remedy } = {},
): Promise<DecisionResult> => recordDecision(input, verdict, detail);

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function sampleRow(auditSampleId: number) {
  const [row] = await db
    .select()
    .from(schema.auditSamples)
    .where(eq(schema.auditSamples.id, auditSampleId));
  return row;
}

async function statusOf(auditSampleId: number): Promise<string> {
  return (await sampleRow(auditSampleId))?.status ?? "(missing)";
}

async function followUpOf(auditSampleId: number): Promise<string | null> {
  return (await sampleRow(auditSampleId))?.pendingFollowUp ?? null;
}

async function decisionCount(runId: string, sampleId: number): Promise<number> {
  const rows = await db
    .select({ id: schema.refereeDecisions.id })
    .from(schema.refereeDecisions)
    .where(
      and(eq(schema.refereeDecisions.runId, runId), eq(schema.refereeDecisions.sampleId, sampleId)),
    );
  return rows.length;
}

async function learnedRows(runId: string, sampleId: number) {
  return db
    .select()
    .from(schema.learnedRules)
    .where(and(eq(schema.learnedRules.runId, runId), eq(schema.learnedRules.sampleId, sampleId)))
    .orderBy(schema.learnedRules.id);
}

async function main() {
  const probe = await createProbeRun();
  const runId = String(probe.runId);
  const input = { runId, sampleType: "invoice", sampleId: probe.invoiceId };

  try {
    // ---- 1 and 2. the four verdicts move status and the follow-up note ----
    const sufficient = await rule(input, "sufficient");
    check("sufficient succeeds on a real run", sufficient.ok, sufficient.ok ? "" : sufficient.message);
    check("sufficient sets audit_samples.status to defended", (await statusOf(probe.auditSampleId)) === "defended", await statusOf(probe.auditSampleId));
    check("sufficient writes one referee_decisions row", (await decisionCount(runId, probe.invoiceId)) === 1);
    check("sufficient teaches nothing", (await learnedRows(runId, probe.invoiceId)).length === 0);

    const needsMore = await rule(input, "needs_more", { note: "Check the contract amendment file." });
    check("needs_more succeeds", needsMore.ok, needsMore.ok ? "" : needsMore.message);
    check("needs_more returns audit_samples.status to open", (await statusOf(probe.auditSampleId)) === "open", await statusOf(probe.auditSampleId));
    check(
      "needs_more hands the note to the engine on pending_follow_up",
      (await followUpOf(probe.auditSampleId)) === "Check the contract amendment file.",
      String(await followUpOf(probe.auditSampleId)),
    );

    const acceptedWithNote = await rule(input, "accepted_with_note", {
      note: "Below the threshold worth chasing this year.",
    });
    check("accepted_with_note succeeds", acceptedWithNote.ok, acceptedWithNote.ok ? "" : acceptedWithNote.message);
    check("accepted_with_note settles the sample as defended", (await statusOf(probe.auditSampleId)) === "defended", await statusOf(probe.auditSampleId));
    check(
      "it clears the follow-up note the engine would otherwise re-run",
      (await followUpOf(probe.auditSampleId)) === null,
      String(await followUpOf(probe.auditSampleId)),
    );

    const exception = await rule(input, "exception", { remedy: "recover_cash", note: "Duplicate settlement." });
    check("exception succeeds", exception.ok, exception.ok ? "" : exception.message);
    check("exception sets audit_samples.status to gap", (await statusOf(probe.auditSampleId)) === "gap", await statusOf(probe.auditSampleId));
    check("all four rulings are on file", (await decisionCount(runId, probe.invoiceId)) === 4);

    const [lastDecision] = await db
      .select()
      .from(schema.refereeDecisions)
      .where(eq(schema.refereeDecisions.runId, runId))
      .orderBy(desc(schema.refereeDecisions.id))
      .limit(1);
    check("run_id is stored as the numeric audit run id in text", lastDecision?.runId === runId, lastDecision?.runId);
    check("the remedy is stored on the exception", lastDecision?.remedy === "recover_cash", String(lastDecision?.remedy));

    // ---- 3. learned_rules ----
    const learned = await learnedRows(runId, probe.invoiceId);
    check(
      "learned_rules has one row per ruling that carries judgement, and none for sufficient",
      learned.length === 3,
      `${learned.length} rows: ${learned.map((r) => r.verdict).join(", ")}`,
    );
    check(
      "the verdicts recorded are needs_more, accepted_with_note, exception",
      learned.map((r) => r.verdict).join(",") === "needs_more,accepted_with_note,exception",
      learned.map((r) => r.verdict).join(","),
    );
    check(
      "every learned rule names the sample it came from",
      learned.every((r) => r.sampleType === "invoice" && r.sampleId === probe.invoiceId),
    );
    check(
      "every learned rule carries a gap kind",
      learned.every((r) => typeof r.gapKind === "string" && r.gapKind.length > 0),
      learned.map((r) => r.gapKind).join(","),
    );
    check(
      "the gap kind is the one the accountant admitted, not a placeholder",
      learned.every((r) => r.gapKind === "missing_approval"),
      learned.map((r) => r.gapKind).join(","),
    );
    check(
      "the counterparty is the vendor name off the sample",
      learned.every((r) => r.counterparty === probe.vendorName),
      `${learned.map((r) => r.counterparty).join(",")} (expected ${probe.vendorName})`,
    );
    check(
      "the remedy is on the exception rule and on no other",
      learned.filter((r) => r.remedy !== null).map((r) => `${r.verdict}:${r.remedy}`).join(",") ===
        "exception:recover_cash",
      learned.map((r) => `${r.verdict}:${r.remedy}`).join(","),
    );
    check(
      "the note the controller typed is carried onto the rule",
      learned[0]?.note === "Check the contract amendment file.",
      String(learned[0]?.note),
    );

    const view = await getRun(runId);
    const sample = view?.samples.find((s) => s.id === `invoice:${probe.invoiceId}`);
    check("the rendered status matches audit_samples.status", sample?.status === "gap", sample?.status);
    check(
      "each ruling appended a referee turn to the thread",
      sample?.thread.filter((m) => m.role === "referee").length === 4,
      `${sample?.thread.filter((m) => m.role === "referee").length} referee turns`,
    );
    check(
      "the needs_more note is carried into the thread",
      Boolean(sample?.thread.some((m) => m.content.includes("Check the contract amendment file."))),
    );
    check(
      "the remedy is named in the thread, so the transcript says what was decided",
      Boolean(sample?.thread.some((m) => m.content.includes("Remedy: recover cash"))),
    );
    check("the last ruling is hung on the sample for the list marker", sample?.ruling?.verdict === "exception", sample?.ruling?.verdict);

    // ---- 4. a verdict without what it requires ----
    const decisionsBefore = await decisionCount(runId, probe.invoiceId);
    const learnedBefore = (await learnedRows(runId, probe.invoiceId)).length;
    const noNote = await rule(input, "needs_more", { note: "   " });
    check("needs_more with no note is refused", !noNote.ok, noNote.ok ? "accepted" : noNote.message);
    const noAcceptNote = await rule(input, "accepted_with_note");
    check("accepted_with_note with no note is refused", !noAcceptNote.ok, noAcceptNote.ok ? "accepted" : noAcceptNote.message);
    const noRemedy = await rule(input, "exception");
    check("exception with no remedy is refused", !noRemedy.ok, noRemedy.ok ? "accepted" : noRemedy.message);
    const badRemedy = await rule(input, "exception", { remedy: "write_it_off" as Remedy });
    check("exception with an unknown remedy is refused", !badRemedy.ok, badRemedy.ok ? "accepted" : badRemedy.message);
    const badVerdict = await rule(input, "approve" as Verdict);
    check("a pre-verdict decision name is refused", !badVerdict.ok, badVerdict.ok ? "accepted" : badVerdict.message);
    check("none of the refusals wrote a decision", (await decisionCount(runId, probe.invoiceId)) === decisionsBefore);
    check("none of the refusals wrote a learned rule", (await learnedRows(runId, probe.invoiceId)).length === learnedBefore);
    check("none of the refusals moved the status", (await statusOf(probe.auditSampleId)) === "gap");

    // A remedy is meaningless on a verdict with no finding, so it is dropped.
    const strayRemedy = await rule(input, "sufficient", { remedy: "post_entry" });
    check("sufficient succeeds even with a stray remedy", strayRemedy.ok, strayRemedy.ok ? "" : strayRemedy.message);
    const [afterStray] = await db
      .select()
      .from(schema.refereeDecisions)
      .where(eq(schema.refereeDecisions.runId, runId))
      .orderBy(desc(schema.refereeDecisions.id))
      .limit(1);
    check("the stray remedy is not stored", afterStray?.remedy === null, String(afterStray?.remedy));

    // ---- 5. nothing is written for samples outside the run ----
    const otherStatusBefore = await statusOf(probe.bankAuditSampleId);
    const foreign = await rule({ runId, sampleType: "invoice", sampleId: probe.foreignInvoiceId }, "sufficient");
    check("a sample that is not in the run is rejected", !foreign.ok, foreign.ok ? "accepted" : foreign.message);
    check("nothing was written for it", (await decisionCount(runId, probe.foreignInvoiceId)) === 0);
    check("no other sample's status was touched", (await statusOf(probe.bankAuditSampleId)) === otherStatusBefore);

    const missingRunId = String(probe.runId + 100000);
    const missingRun = await rule({ runId: missingRunId, sampleType: "invoice", sampleId: probe.invoiceId }, "sufficient");
    check("a run that does not exist is rejected", !missingRun.ok, missingRun.ok ? "accepted" : missingRun.message);
    check("nothing was written under that run id", (await decisionCount(missingRunId, probe.invoiceId)) === 0);

    // ---- 7. bad input is a result, not a throw ----
    const badType = await rule({ runId, sampleType: "not_a_table", sampleId: 1 }, "sufficient");
    check("an unknown sample type is rejected", !badType.ok, badType.ok ? "accepted" : badType.message);
    const badId = await rule({ runId, sampleType: "invoice", sampleId: -3 }, "sufficient");
    check("a negative sample id is rejected", !badId.ok, badId.ok ? "accepted" : badId.message);
    check(
      "no rejection message leaks database detail",
      [badType, badId, noNote, noRemedy, foreign, missingRun].every(
        (r) => r.ok || !/relation|column|syntax|postgres|drizzle|constraint/i.test(r.message),
      ),
    );

    // ---- 6. mock rulings ----
    const mockSample = (await getRun(MOCK_RUN_ID))?.samples[0];
    if (!mockSample) throw new Error("the mock run has no samples");
    const [, rawId] = mockSample.id.split(":");
    const mockInput = { runId: MOCK_RUN_ID, sampleType: mockSample.type, sampleId: Number(rawId) };
    const decisionMark = await lastId(schema.refereeDecisions);
    const learnedMark = await lastId(schema.learnedRules);
    const beforeCount = await decisionCount(MOCK_RUN_ID, Number(rawId));
    const mockResult = await rule(mockInput, "exception", { remedy: "fix_control" });
    check("a verdict succeeds on the mock run", mockResult.ok, mockResult.ok ? "" : mockResult.message);
    check("it is filed under \"mock\"", (await decisionCount(MOCK_RUN_ID, Number(rawId))) === beforeCount + 1);
    const mockLearned = await learnedRows(MOCK_RUN_ID, Number(rawId));
    check(
      "the mock run teaches the same shape of rule as a real one",
      mockLearned.some((r) => r.verdict === "exception" && r.remedy === "fix_control" && r.gapKind.length > 0),
      mockLearned.map((r) => `${r.verdict}/${r.gapKind}/${r.counterparty}`).join(" "),
    );
    const reread = await loadDecisions(MOCK_RUN_ID);
    check(
      "a fresh read sees it, so nothing depends on process-local state",
      (reread.get(mockSample.id)?.length ?? 0) >= 1,
    );
    const mockView = await getRun(MOCK_RUN_ID);
    check(
      "the mock sample's status is derived from the ruling",
      mockView?.samples.find((s) => s.id === mockSample.id)?.status === "gap",
      mockView?.samples.find((s) => s.id === mockSample.id)?.status,
    );

    const strayMock = await rule({ runId: MOCK_RUN_ID, sampleType: "invoice", sampleId: 999999 }, "sufficient");
    check("a sample outside the mock run is rejected", !strayMock.ok, strayMock.ok ? "accepted" : strayMock.message);
    check("nothing was written for it", (await decisionCount(MOCK_RUN_ID, 999999)) === 0);

    // Leave the mock run as this check found it, in both tables.
    await db
      .delete(schema.refereeDecisions)
      .where(and(eq(schema.refereeDecisions.runId, MOCK_RUN_ID), gt(schema.refereeDecisions.id, decisionMark)));
    await db
      .delete(schema.learnedRules)
      .where(and(eq(schema.learnedRules.runId, MOCK_RUN_ID), gt(schema.learnedRules.id, learnedMark)));
    const restored = await getRun(MOCK_RUN_ID);
    check(
      "the mock run is left exactly as the check found it",
      restored?.samples.find((s) => s.id === mockSample.id)?.status === mockSample.status,
      `${mockSample.status} -> ${restored?.samples.find((s) => s.id === mockSample.id)?.status}`,
    );
    check(
      "no learned rule is left behind under \"mock\"",
      (await learnedRows(MOCK_RUN_ID, Number(rawId))).length === 0,
    );
  } finally {
    await deleteProbeRun(probe.runId);
  }
}

async function lastId(table: typeof schema.refereeDecisions | typeof schema.learnedRules): Promise<number> {
  const [row] = await db.select({ id: table.id }).from(table).orderBy(desc(table.id)).limit(1);
  return row?.id ?? 0;
}

type ProbeRun = {
  runId: number;
  invoiceId: number;
  vendorName: string;
  auditSampleId: number;
  bankAuditSampleId: number;
  /** A real invoice that is deliberately not part of the run. */
  foreignInvoiceId: number;
};

async function createProbeRun(): Promise<ProbeRun> {
  const invoices = await db.select().from(schema.invoices).orderBy(desc(schema.invoices.id)).limit(3);
  const [bank] = await db
    .select()
    .from(schema.bankTransactions)
    .orderBy(desc(schema.bankTransactions.id))
    .limit(1);
  if (invoices.length < 2 || !bank) throw new Error("the database is not seeded; run pnpm seed first");
  const [vendor] = await db
    .select()
    .from(schema.vendors)
    .where(eq(schema.vendors.id, invoices[0].vendorId));
  if (!vendor) throw new Error("the sampled invoice has no vendor row");

  const run = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.auditRuns)
      .values({ name: "referee action check (temporary)", status: "complete", sampleCount: 2, notes: "seed=check" })
      .returning();

    const [sample] = await tx
      .insert(schema.auditSamples)
      .values({
        runId: created.id,
        sampleType: "invoice",
        sampleId: invoices[0].id,
        amount: invoices[0].amount,
        riskScore: 0.5,
        riskReasons: ["check probe"],
        status: "open",
      })
      .returning();

    const [bankSample] = await tx
      .insert(schema.auditSamples)
      .values({
        runId: created.id,
        sampleType: "bank_transaction",
        sampleId: bank.id,
        amount: bank.amount,
        riskScore: 0.4,
        riskReasons: ["check probe"],
        status: "open",
      })
      .returning();

    // An accountant turn with an admitted gap, so the learned rule has a real
    // gap kind to record rather than the "other" fallback.
    await tx.insert(schema.auditExchanges).values([
      {
        runId: created.id,
        sampleId: sample.id,
        turn: 1,
        role: "auditor",
        questionTemplateId: "probe",
        content: `Support this invoice [invoices#${invoices[0].id}].`,
      },
      {
        runId: created.id,
        sampleId: sample.id,
        turn: 2,
        role: "accountant",
        content: `No approver is recorded on this invoice [invoices#${invoices[0].id}].`,
        evidence: {
          sample: { type: "invoice", id: invoices[0].id },
          citations: [
            {
              table: "invoices",
              id: invoices[0].id,
              field: "approved_by",
              value: "",
              reason: "The approval field the invoice leaves blank.",
            },
          ],
          gaps: [
            {
              kind: "missing_approval",
              description: "The invoice carries no approver.",
            },
          ],
        },
      },
    ]);

    return {
      runId: created.id,
      invoiceId: invoices[0].id,
      vendorName: vendor.name,
      auditSampleId: sample.id,
      bankAuditSampleId: bankSample.id,
      foreignInvoiceId: invoices[1].id,
    };
  });

  return run;
}

async function deleteProbeRun(runId: number) {
  await db.delete(schema.auditExchanges).where(eq(schema.auditExchanges.runId, runId));
  await db.delete(schema.auditSamples).where(eq(schema.auditSamples.runId, runId));
  await db.delete(schema.refereeDecisions).where(eq(schema.refereeDecisions.runId, String(runId)));
  await db.delete(schema.learnedRules).where(eq(schema.learnedRules.runId, String(runId)));
  await db.delete(schema.auditRuns).where(eq(schema.auditRuns.id, runId));
}

main()
  .then(async () => {
    const { sql } = await import("@/db");
    await sql.end();
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll referee action checks passed.");
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    const { sql } = await import("@/db");
    await sql.end().catch(() => {});
    process.exit(1);
  });

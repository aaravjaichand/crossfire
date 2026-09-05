/**
 * pnpm referee:check-actions
 *
 * Proves the referee actions against a seeded crossfire_c:
 *   1. Approve, redirect, and concede on a real run insert a referee_decisions
 *      row and move audit_samples.status to defended / open / conceded in the
 *      same transaction.
 *   2. A sample that is not in the named run, and a run that does not exist,
 *      are rejected without writing anything.
 *   3. Mock decisions are filed under "mock" and survive a fresh read, since
 *      nothing is cached in the process.
 *   4. Failures come back as a result the UI can render, not as a thrown
 *      database error.
 *
 * Creates a throwaway audit run and deletes it again, so it can be re-run.
 */
import "./load-env";
import { and, desc, eq, gt } from "drizzle-orm";
import { db, schema } from "@/db";
import { normaliseNote, recordDecision, type DecisionInput, type DecisionResult } from "./decide";
import { getRun } from "./data";
import { loadDecisions } from "./decisions";
import { MOCK_RUN_ID } from "./mock-run";

// actions.ts is a "use server" wrapper that adds revalidatePath around this
// same core, which cannot run outside a Next request.
const approve = (input: DecisionInput) => recordDecision(input, "approve", null);
const concede = (input: DecisionInput) => recordDecision(input, "concede", null);
const redirect = async (input: DecisionInput, note: string): Promise<DecisionResult> => {
  const trimmed = normaliseNote(note);
  if (!trimmed) {
    return { ok: false, message: "A redirect needs a note telling the accountant where to look." };
  }
  return recordDecision(input, "redirect", trimmed);
};

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function statusOf(auditSampleId: number): Promise<string> {
  const [row] = await db
    .select({ status: schema.auditSamples.status })
    .from(schema.auditSamples)
    .where(eq(schema.auditSamples.id, auditSampleId));
  return row?.status ?? "(missing)";
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

async function main() {
  const probe = await createProbeRun();
  const runId = String(probe.runId);
  const input = { runId, sampleType: "invoice", sampleId: probe.invoiceId };

  try {
    // ---- 1. the three decisions move status atomically ----
    const approved = await approve(input);
    check("approve() succeeds on a real run", approved.ok, approved.ok ? "" : approved.message);
    check("approve sets audit_samples.status to defended", (await statusOf(probe.auditSampleId)) === "defended", await statusOf(probe.auditSampleId));
    check("approve writes one referee_decisions row", (await decisionCount(runId, probe.invoiceId)) === 1);

    const redirected = await redirect(input, "Check the contract amendment file.");
    check("redirect() succeeds", redirected.ok, redirected.ok ? "" : redirected.message);
    check("redirect returns audit_samples.status to open", (await statusOf(probe.auditSampleId)) === "open", await statusOf(probe.auditSampleId));

    const conceded = await concede(input);
    check("concede() succeeds", conceded.ok, conceded.ok ? "" : conceded.message);
    check("concede sets audit_samples.status to conceded", (await statusOf(probe.auditSampleId)) === "conceded", await statusOf(probe.auditSampleId));
    check("all three decisions are on file", (await decisionCount(runId, probe.invoiceId)) === 3);

    const [last] = await db
      .select()
      .from(schema.refereeDecisions)
      .where(eq(schema.refereeDecisions.runId, runId))
      .orderBy(desc(schema.refereeDecisions.id))
      .limit(1);
    check("run_id is stored as the numeric audit run id in text", last?.runId === runId, last?.runId);

    const view = await getRun(runId);
    const sample = view?.samples.find((s) => s.id === `invoice:${probe.invoiceId}`);
    check("the rendered status matches audit_samples.status", sample?.status === "conceded", sample?.status);
    check(
      "each decision appended a referee turn to the thread",
      sample?.thread.filter((m) => m.role === "referee").length === 3,
      `${sample?.thread.filter((m) => m.role === "referee").length} referee turns`,
    );
    check(
      "the redirect note is carried into the thread",
      Boolean(sample?.thread.some((m) => m.content.includes("Check the contract amendment file."))),
    );

    // ---- 2. nothing is written for samples outside the run ----
    const otherStatusBefore = await statusOf(probe.bankAuditSampleId);
    const foreign = await approve({ runId, sampleType: "invoice", sampleId: probe.foreignInvoiceId });
    check("a sample that is not in the run is rejected", !foreign.ok, foreign.ok ? "accepted" : foreign.message);
    check("nothing was written for it", (await decisionCount(runId, probe.foreignInvoiceId)) === 0);
    check("no other sample's status was touched", (await statusOf(probe.bankAuditSampleId)) === otherStatusBefore);

    const missingRunId = String(probe.runId + 100000);
    const missingRun = await approve({ runId: missingRunId, sampleType: "invoice", sampleId: probe.invoiceId });
    check("a run that does not exist is rejected", !missingRun.ok, missingRun.ok ? "accepted" : missingRun.message);
    check("nothing was written under that run id", (await decisionCount(missingRunId, probe.invoiceId)) === 0);

    // ---- 4. bad input is a result, not a throw ----
    const badType = await approve({ runId, sampleType: "not_a_table", sampleId: 1 });
    check("an unknown sample type is rejected", !badType.ok, badType.ok ? "accepted" : badType.message);
    const badId = await approve({ runId, sampleType: "invoice", sampleId: -3 });
    check("a negative sample id is rejected", !badId.ok, badId.ok ? "accepted" : badId.message);
    const emptyNote = await redirect(input, "   ");
    check("a redirect with no note is rejected", !emptyNote.ok, emptyNote.ok ? "accepted" : emptyNote.message);
    check(
      "no rejection message leaks database detail",
      [badType, badId, emptyNote, foreign, missingRun].every(
        (r) => r.ok || !/relation|column|syntax|postgres|drizzle|constraint/i.test(r.message),
      ),
    );

    // ---- 3. mock decisions ----
    const mockSample = (await getRun(MOCK_RUN_ID))?.samples[0];
    if (!mockSample) throw new Error("the mock run has no samples");
    const [, rawId] = mockSample.id.split(":");
    const mockInput = { runId: MOCK_RUN_ID, sampleType: mockSample.type, sampleId: Number(rawId) };
    const highWaterMark = await lastDecisionId();
    const beforeCount = await decisionCount(MOCK_RUN_ID, Number(rawId));
    const mockResult = await approve(mockInput);
    check("approve() succeeds on the mock run", mockResult.ok, mockResult.ok ? "" : mockResult.message);
    check("it is filed under \"mock\"", (await decisionCount(MOCK_RUN_ID, Number(rawId))) === beforeCount + 1);
    const reread = await loadDecisions(MOCK_RUN_ID);
    check(
      "a fresh read sees it, so nothing depends on process-local state",
      (reread.get(mockSample.id)?.length ?? 0) >= 1,
    );
    const mockView = await getRun(MOCK_RUN_ID);
    check(
      "the mock sample's status is derived from the decision",
      mockView?.samples.find((s) => s.id === mockSample.id)?.status === "defended",
    );

    const strayMock = await approve({ runId: MOCK_RUN_ID, sampleType: "invoice", sampleId: 999999 });
    check("a sample outside the mock run is rejected", !strayMock.ok, strayMock.ok ? "accepted" : strayMock.message);
    check("nothing was written for it", (await decisionCount(MOCK_RUN_ID, 999999)) === 0);

    // Leave the mock run as this check found it.
    await db
      .delete(schema.refereeDecisions)
      .where(
        and(
          eq(schema.refereeDecisions.runId, MOCK_RUN_ID),
          gt(schema.refereeDecisions.id, highWaterMark),
        ),
      );
    const restored = await getRun(MOCK_RUN_ID);
    check(
      "the mock run is left exactly as the check found it",
      restored?.samples.find((s) => s.id === mockSample.id)?.status === mockSample.status,
      `${mockSample.status} -> ${restored?.samples.find((s) => s.id === mockSample.id)?.status}`,
    );
  } finally {
    await deleteProbeRun(probe.runId);
  }
}

async function lastDecisionId(): Promise<number> {
  const [row] = await db
    .select({ id: schema.refereeDecisions.id })
    .from(schema.refereeDecisions)
    .orderBy(desc(schema.refereeDecisions.id))
    .limit(1);
  return row?.id ?? 0;
}

type ProbeRun = {
  runId: number;
  invoiceId: number;
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
  if (invoices.length < 2 || !bank) throw new Error("crossfire_c is not seeded; run pnpm seed first");

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(schema.auditRuns)
      .values({ name: "referee action check (temporary)", status: "complete", sampleCount: 2, notes: "seed=check" })
      .returning();

    const [sample] = await tx
      .insert(schema.auditSamples)
      .values({
        runId: run.id,
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
        runId: run.id,
        sampleType: "bank_transaction",
        sampleId: bank.id,
        amount: bank.amount,
        riskScore: 0.4,
        riskReasons: ["check probe"],
        status: "open",
      })
      .returning();

    await tx.insert(schema.auditExchanges).values({
      runId: run.id,
      sampleId: sample.id,
      turn: 1,
      role: "auditor",
      questionTemplateId: "probe",
      content: `Support this invoice [invoices#${invoices[0].id}].`,
    });

    return {
      runId: run.id,
      invoiceId: invoices[0].id,
      auditSampleId: sample.id,
      bankAuditSampleId: bankSample.id,
      foreignInvoiceId: invoices[1].id,
    };
  });
}

async function deleteProbeRun(runId: number) {
  await db.delete(schema.auditExchanges).where(eq(schema.auditExchanges.runId, runId));
  await db.delete(schema.auditSamples).where(eq(schema.auditSamples.runId, runId));
  await db.delete(schema.refereeDecisions).where(eq(schema.refereeDecisions.runId, String(runId)));
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

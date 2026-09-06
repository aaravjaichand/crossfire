/**
 * pnpm referee:check-data
 *
 * Covers the data layer against a seeded crossfire_c:
 *   1. /audit/mock still builds from live rows, with every sample described
 *      from its source table.
 *   2. A real audit run loads from audit_runs/audit_samples/audit_exchanges,
 *      and audit_samples.id (the conversation row, which audit_exchanges
 *      points at) is kept distinct from audit_samples.sample_id (the
 *      underlying row the URL names).
 *   3. An unknown numeric run id resolves to nothing rather than silently
 *      falling through to the mock run, so a decision aimed at a run that does
 *      not exist cannot land on unrelated rows.
 *   4. runVersion() changes when a status or a thread changes, which is what
 *      tells the client to refresh the sample list and coverage ring.
 *
 * Creates a throwaway audit run and deletes it again, so it can be re-run.
 */
import "./load-env";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { coverage, getRun, getSample, resolveRunId, runVersion } from "./data";
import { MOCK_RUN_ID } from "./mock-run";
import { parseEvidenceBundle } from "./parse-evidence";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  // ---- 1. the mock run ----
  const mock = await getRun(MOCK_RUN_ID);
  check("getRun(\"mock\") returns a run", Boolean(mock));
  if (!mock) return;

  check("the mock run is flagged as mock", mock.kind === "mock", mock.kind);
  check("the mock run files decisions under \"mock\"", mock.id === MOCK_RUN_ID, mock.id);
  check("the mock run has samples", mock.samples.length > 0, `${mock.samples.length} samples`);
  check(
    "every mock sample has a label, an amount, and a date from its source table",
    mock.samples.every((s) => s.label.length > 0 && s.amount.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(s.date)),
  );
  check(
    "no mock sample carries an audit_samples id, because it has no such row",
    mock.samples.every((s) => s.auditSampleId === undefined),
  );
  check(
    "every accountant turn carries a parsed evidence bundle",
    mock.samples.every((s) =>
      s.thread.filter((m) => m.role === "accountant").every((m) => (m.evidence?.citations.length ?? 0) > 0),
    ),
  );

  const cov = coverage(mock);
  check("coverage counts only defended samples", cov.defended === mock.samples.filter((s) => s.status === "defended").length, `${cov.defended}/${cov.total} = ${cov.percent}%`);

  // Reaching the mock run by another name canonicalises to "mock", so mock
  // decisions never accumulate under stray ids.
  const alias = await getRun("not-a-real-run");
  check("a non-numeric unknown id serves the mock run under the \"mock\" key", alias?.id === MOCK_RUN_ID, alias?.id);

  // ---- 3. unknown real run ----
  check("a numeric id resolves as a real run id", resolveRunId("12").kind === "real");
  check("\"mock\" resolves as the mock run", resolveRunId(MOCK_RUN_ID).kind === "mock");
  check("a leading-zero id is not treated as a different real run", resolveRunId("012").kind === "real");

  const [maxRun] = await db
    .select({ id: schema.auditRuns.id })
    .from(schema.auditRuns)
    .orderBy(desc(schema.auditRuns.id));
  const unknownId = String((maxRun?.id ?? 0) + 100000);
  const unknown = await getRun(unknownId);
  check(`getRun("${unknownId}") on a run that does not exist returns null`, unknown === null);

  // ---- 2 and 4. a real run ----
  const created = await createProbeRun();
  try {
    const real = await getRun(String(created.runId));
    check("a real run loads from audit_runs", Boolean(real));
    if (!real) return;

    check("the real run is flagged as real", real.kind === "real", real.kind);
    check("the real run files decisions under its numeric id", real.id === String(created.runId), real.id);
    check("the real run has both samples", real.samples.length === 2, `${real.samples.length} samples`);

    const invoice = real.samples.find((s) => s.id === `invoice:${created.invoiceId}`);
    check(`the URL id is built from audit_samples.sample_id (invoice:${created.invoiceId})`, Boolean(invoice));
    check(
      "the audit_samples.id is carried separately and is not the sample_id",
      invoice?.auditSampleId === created.invoiceAuditSampleId &&
        invoice?.auditSampleId !== created.invoiceId,
      `auditSampleId=${invoice?.auditSampleId} sample_id=${created.invoiceId}`,
    );
    check(
      "the label and date come from the seeded invoices row, not from audit_samples",
      Boolean(invoice && invoice.label.includes("·") && invoice.date === created.invoiceDate),
      `${invoice?.label} / ${invoice?.date}`,
    );
    check(
      "the thread is the exchange rows for that audit_samples.id",
      invoice?.thread.length === 2 && invoice.thread[0].role === "auditor" && invoice.thread[1].role === "accountant",
      `${invoice?.thread.length} turns`,
    );
    check(
      "the stored EvidenceBundle JSON is parsed back off the accountant turn",
      invoice?.thread[1].evidence?.citations[0]?.table === "invoices",
      JSON.stringify(invoice?.thread[1].evidence?.citations[0] ?? null),
    );
    check(
      "the status comes from audit_samples.status",
      invoice?.status === "open",
      invoice?.status,
    );

    const bank = real.samples.find((s) => s.id === `bank:${created.bankId}`);
    check(`the second sample keeps its own ids (bank:${created.bankId})`, bank?.auditSampleId === created.bankAuditSampleId);
    check("a sample with no exchange rows still renders with an empty thread", bank?.thread.length === 0);

    // ---- 4. runVersion ----
    const before = runVersion(real);
    await db
      .update(schema.auditSamples)
      .set({ status: "defended" })
      .where(eq(schema.auditSamples.id, created.invoiceAuditSampleId));
    const after = await getRun(String(created.runId));
    check("runVersion changes when a sample status changes", after !== null && runVersion(after) !== before);
    check("the coverage ring sees the new status", after !== null && coverage(after).defended === 1, `${after ? coverage(after).defended : "?"} defended`);

    const single = await getSample(String(created.runId), `invoice:${created.invoiceId}`);
    check("getSample resolves one sample of a real run", single?.id === `invoice:${created.invoiceId}`);
    check("getSample returns null for a sample outside the run", (await getSample(String(created.runId), "invoice:999999")) === null);

    // ---- malformed evidence ----
    check("a malformed evidence blob is dropped rather than rendered", parseEvidenceBundle({ nope: true }) === undefined);
    check("a null evidence column is dropped", parseEvidenceBundle(null) === undefined);
    check(
      "a well-formed bundle survives the round trip",
      parseEvidenceBundle({ sample: { type: "invoice", id: 1 }, citations: [], gaps: [] })?.sample.id === 1,
    );

    // The parser rebuilds the bundle field by field, so anything it does not
    // name is dropped. defenseSource is written by the engine and read by the
    // transcript, so it has to survive that rebuild.
    const withSource = parseEvidenceBundle({
      sample: { type: "invoice", id: 1 },
      citations: [],
      gaps: [],
      defenseSource: { source: "fallback", reason: "uncited sentence" },
    });
    check(
      "defenseSource survives the parse",
      withSource?.defenseSource?.source === "fallback" &&
        withSource.defenseSource.reason === "uncited sentence",
      JSON.stringify(withSource?.defenseSource ?? null),
    );
    // The engine omits `reason` entirely for a model-written defense, so this
    // is the shape the common case actually arrives in.
    const modelSource = parseEvidenceBundle({
      sample: { type: "invoice", id: 1 },
      citations: [],
      gaps: [],
      defenseSource: { source: "model" },
    })?.defenseSource;
    check(
      "a model-written defense keeps its source with no reason attached",
      modelSource?.source === "model" && modelSource.reason === undefined,
      JSON.stringify(modelSource ?? null),
    );
    check(
      "a bundle written before the engine recorded it parses without one",
      parseEvidenceBundle({ sample: { type: "invoice", id: 1 }, citations: [], gaps: [] })
        ?.defenseSource === undefined,
    );
    check(
      "a defenseSource with an unknown source is dropped rather than rendered",
      parseEvidenceBundle({
        sample: { type: "invoice", id: 1 },
        citations: [],
        gaps: [],
        defenseSource: { source: "guessed", reason: "x" },
      })?.defenseSource === undefined,
    );
  } finally {
    await deleteProbeRun(created.runId);
  }
}

type ProbeRun = {
  runId: number;
  invoiceId: number;
  invoiceDate: string;
  invoiceAuditSampleId: number;
  bankId: number;
  bankAuditSampleId: number;
};

/**
 * Builds a two-sample run of the shape src/lib/auditor/persist.ts writes, and
 * deliberately picks source rows whose ids differ from the audit_samples ids
 * they are stored under. On a fresh table the two sequences would otherwise
 * line up and a getRun that confused one for the other would still pass.
 */
async function createProbeRun(): Promise<ProbeRun> {
  const invoices = await db.select().from(schema.invoices).orderBy(desc(schema.invoices.id)).limit(2);
  const banks = await db
    .select()
    .from(schema.bankTransactions)
    .orderBy(desc(schema.bankTransactions.id))
    .limit(2);
  if (invoices.length < 2 || banks.length < 2) {
    throw new Error("crossfire_c is not seeded; run pnpm seed first");
  }

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(schema.auditRuns)
      .values({ name: "referee data check (temporary)", status: "complete", sampleCount: 2, notes: "seed=check" })
      .returning();

    const [invoiceSample] = await tx
      .insert(schema.auditSamples)
      .values({
        runId: run.id,
        sampleType: "invoice",
        sampleId: 0,
        amount: invoices[0].amount,
        riskScore: 0.5,
        riskReasons: ["check probe"],
        status: "open",
      })
      .returning();
    const invoice = invoices.find((r) => r.id !== invoiceSample.id) ?? invoices[0];
    await tx
      .update(schema.auditSamples)
      .set({ sampleId: invoice.id, amount: invoice.amount })
      .where(eq(schema.auditSamples.id, invoiceSample.id));

    const [bankSample] = await tx
      .insert(schema.auditSamples)
      .values({
        runId: run.id,
        sampleType: "bank_transaction",
        sampleId: 0,
        amount: banks[0].amount,
        riskScore: 0.4,
        riskReasons: ["check probe"],
        status: "open",
      })
      .returning();
    const bank = banks.find((r) => r.id !== bankSample.id) ?? banks[0];
    await tx
      .update(schema.auditSamples)
      .set({ sampleId: bank.id, amount: bank.amount })
      .where(eq(schema.auditSamples.id, bankSample.id));

    await tx.insert(schema.auditExchanges).values([
      {
        runId: run.id,
        sampleId: invoiceSample.id,
        turn: 1,
        role: "auditor",
        questionTemplateId: "probe",
        content: `Support this invoice [invoices#${invoice.id}].`,
      },
      {
        runId: run.id,
        sampleId: invoiceSample.id,
        turn: 2,
        role: "accountant",
        content: `The invoice is on file [invoices#${invoice.id}].`,
        evidence: {
          sample: { type: "invoice", id: invoice.id },
          citations: [
            {
              table: "invoices",
              id: invoice.id,
              field: "amount",
              value: invoice.amount,
              reason: "The invoice under examination.",
            },
          ],
          gaps: [],
        },
      },
    ]);

    return {
      runId: run.id,
      invoiceId: invoice.id,
      invoiceDate: invoice.issueDate,
      invoiceAuditSampleId: invoiceSample.id,
      bankId: bank.id,
      bankAuditSampleId: bankSample.id,
    };
  });
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
    console.log("\nAll referee data checks passed.");
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    const { sql } = await import("@/db");
    await sql.end().catch(() => {});
    process.exit(1);
  });

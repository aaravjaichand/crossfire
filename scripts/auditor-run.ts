/**
 * pnpm auditor:run [--seed N] [--name "..."]
 *
 * Creates an audit_runs row, draws 25 risk-weighted samples from
 * bank_transactions, invoices, and dodo_transactions, inserts them as
 * audit_samples, and writes the opening auditor question per sample as
 * turn 1 in audit_exchanges (one LLM call per sample to phrase it
 * naturally; falls back to the deterministic template text on error).
 *
 * Same --seed against unchanged data always produces the same picks.
 */
import "./lib/env";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "../src/db";
import { loadSampleDetail } from "../src/lib/auditor/detail";
import { phraseQuestion } from "../src/lib/auditor/llm";
import { chooseQuestion } from "../src/lib/auditor/questions";
import { buildCandidates, pickSamples } from "../src/lib/auditor/sampler";
import { centsToDecimalString, usd } from "../src/lib/auditor/util";

const SAMPLE_COUNT = 25;

function parseArgs(argv: string[]): { seed: number; name: string } {
  let seed = 1;
  let name = `Audit run ${new Date().toISOString()}`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed" && argv[i + 1] !== undefined) {
      seed = Number(argv[++i]);
    } else if (argv[i] === "--name" && argv[i + 1] !== undefined) {
      name = argv[++i];
    }
  }
  if (!Number.isFinite(seed)) throw new Error("--seed must be a number");
  return { seed, name };
}

async function main() {
  const { seed, name } = parseArgs(process.argv.slice(2));
  console.log(`Starting audit run "${name}" (seed=${seed})...`);

  const [run] = await db
    .insert(schema.auditRuns)
    .values({ name, status: "running", sampleCount: SAMPLE_COUNT, notes: `seed=${seed}` })
    .returning();
  console.log(`Created audit_runs row #${run.id}.`);

  const candidates = await buildCandidates();
  console.log(`Scored ${candidates.length} candidate records.`);

  const picks = pickSamples(candidates, seed, SAMPLE_COUNT);
  console.log(`Selected ${picks.length} samples.\n`);

  type Row = {
    type: string;
    id: number;
    amount: string;
    score: string;
    reasons: string;
    question: string;
  };
  const printRows: Row[] = [];

  for (const candidate of picks) {
    const detail = await loadSampleDetail(candidate);
    const { templateId, text: fallbackText } = chooseQuestion(candidate, detail);
    const question = await phraseQuestion(fallbackText);

    const [sampleRow] = await db
      .insert(schema.auditSamples)
      .values({
        runId: run.id,
        sampleType: candidate.sampleType,
        sampleId: candidate.sampleId,
        amount: centsToDecimalString(candidate.amountCents),
        riskScore: candidate.riskScore,
        riskReasons: candidate.riskReasons,
      })
      .returning();

    await db.insert(schema.auditExchanges).values({
      runId: run.id,
      sampleId: sampleRow.id,
      turn: 1,
      role: "auditor",
      questionTemplateId: templateId,
      content: question,
    });

    printRows.push({
      type: candidate.sampleType,
      id: candidate.sampleId,
      amount: usd(candidate.amountCents),
      score: candidate.riskScore.toFixed(4),
      reasons: candidate.riskReasons.join("; ") || "(baseline, no risk flags)",
      question,
    });
  }

  await db.update(schema.auditRuns).set({ status: "complete" }).where(eq(schema.auditRuns.id, run.id));

  printTable(printRows);
  console.log(`\nAudit run #${run.id} complete: ${printRows.length} samples, turn 1 questions written.`);

  await sql.end();
  process.exit(0);
}

function printTable(rows: { type: string; id: number; amount: string; score: string; reasons: string; question: string }[]) {
  const cols: { key: keyof (typeof rows)[number]; label: string; width: number }[] = [
    { key: "type", label: "type", width: 16 },
    { key: "id", label: "id", width: 5 },
    { key: "amount", label: "amount", width: 14 },
    { key: "score", label: "score", width: 7 },
  ];
  const header = cols.map((c) => c.label.padEnd(c.width)).join(" | ") + " | reasons / question";
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of rows) {
    const left = cols.map((c) => String(row[c.key]).padEnd(c.width)).join(" | ");
    console.log(`${left} | ${row.reasons}`);
    console.log(`${" ".repeat(left.length)} | Q: ${row.question}`);
  }
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});

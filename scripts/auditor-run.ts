/**
 * pnpm auditor:run [--seed N] [--name "..."]
 *
 * Draws 25 risk-weighted samples from bank_transactions, invoices, and
 * dodo_transactions, and prepares the opening auditor question for each
 * (one LLM call per sample to phrase it naturally, falling back to the
 * deterministic template text on error; a citation to the exact sampled
 * row is guaranteed by code afterward, never left to the model). Only once
 * every question is ready does it persist the audit_runs/audit_samples/
 * audit_exchanges rows, in a single database transaction (persist.ts): a
 * crash or thrown error partway through leaves zero partial rows behind.
 *
 * Same --seed against unchanged data always produces the same picks.
 */
import "./lib/env";
import { sql } from "../src/db";
import { sampleCitation, withSampleCitation } from "../src/lib/auditor/citation";
import { loadSampleDetail } from "../src/lib/auditor/detail";
import { phraseQuestion } from "../src/lib/auditor/llm";
import { persistRun, type PreparedSample } from "../src/lib/auditor/persist";
import { chooseQuestion } from "../src/lib/auditor/questions";
import { buildCandidates, pickSamples } from "../src/lib/auditor/sampler";
import { usd } from "../src/lib/auditor/util";

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

  const candidates = await buildCandidates();
  console.log(`Scored ${candidates.length} candidate records.`);

  const picks = pickSamples(candidates, seed, SAMPLE_COUNT);
  console.log(`Selected ${picks.length} samples. Preparing questions (one LLM call each)...\n`);

  // Prepare every question before touching the database: a failure here
  // (network, model error) means nothing was ever persisted.
  const prepared: PreparedSample[] = [];
  for (const candidate of picks) {
    const detail = await loadSampleDetail(candidate);
    const { templateId, text: fallbackText } = chooseQuestion(candidate, detail);
    const phrased = await phraseQuestion(fallbackText);
    const question = withSampleCitation(phrased, candidate);
    prepared.push({ candidate, templateId, question });
  }

  const { runId } = await persistRun({ name, seed, samples: prepared });

  printTable(
    prepared.map((p) => ({
      type: p.candidate.sampleType,
      id: p.candidate.sampleId,
      amount: usd(p.candidate.amountCents),
      score: p.candidate.riskScore.toFixed(4),
      reasons: p.candidate.riskReasons.join("; ") || "(baseline, no risk flags)",
      question: p.question,
      citation: sampleCitation(p.candidate),
    })),
  );
  console.log(`\nAudit run #${runId} complete: ${prepared.length} samples, turn 1 questions written.`);

  await sql.end();
  process.exit(0);
}

type PrintRow = {
  type: string;
  id: number;
  amount: string;
  score: string;
  reasons: string;
  question: string;
  citation: string;
};

function printTable(rows: PrintRow[]) {
  const cols: { key: keyof PrintRow; label: string; width: number }[] = [
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
    console.log(`${" ".repeat(left.length)} | Q (${row.citation}): ${row.question}`);
  }
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});

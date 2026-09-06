/**
 * pnpm auditor:run [--seed N] [--name "..."] [--materiality DOLLARS]
 *                  [--samples N] [--cycles purchases,cash,revenue,payroll]
 *                  [--no-llm]
 *
 * A thin CLI over the same two functions the home page form calls
 * (src/lib/engine): prepareRun() draws the sample and writes the run, then
 * runAudit() takes every sample through the accountant and the follow-up
 * policy until it is defended or a gap. The only difference from the app is
 * that the CLI waits for the run to finish so it can print the result.
 *
 * Materiality first: every record at or above --materiality is sampled
 * outright, then the rest of --samples is filled risk-weighted from the
 * seeded PRNG. Same --seed against unchanged data and the same inputs always
 * produces the same picks.
 */
import "./lib/env";
import { sql } from "../src/db";
import { CYCLES } from "../src/lib/auditor/cycles";
import { usd } from "../src/lib/auditor/util";
import { DEFAULT_MATERIALITY_CENTS, DEFAULT_SAMPLE_SIZE } from "../src/lib/engine/inputs";
import { prepareRun } from "../src/lib/engine/start";
import { runAudit, type SampleOutcome } from "../src/lib/engine/run";

type Args = {
  seed: number;
  name: string;
  materiality: number;
  samples: number;
  cycles: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    seed: 1,
    name: `Audit run ${new Date().toISOString()}`,
    materiality: DEFAULT_MATERIALITY_CENTS,
    samples: DEFAULT_SAMPLE_SIZE,
    cycles: [...CYCLES],
  };
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === "--seed" && next !== undefined) {
      args.seed = Number(argv[++i]);
    } else if (argv[i] === "--name" && next !== undefined) {
      args.name = argv[++i];
    } else if (argv[i] === "--materiality" && next !== undefined) {
      // Taken in dollars on the command line, stored in cents.
      args.materiality = Math.round(Number(argv[++i]) * 100);
    } else if (argv[i] === "--samples" && next !== undefined) {
      args.samples = Number(argv[++i]);
    } else if (argv[i] === "--cycles" && next !== undefined) {
      args.cycles = argv[++i].split(",").map((c) => c.trim()).filter(Boolean);
    } else if (argv[i] === "--no-llm") {
      process.env.CROSSFIRE_NO_LLM = "1";
    }
  }
  if (!Number.isFinite(args.seed)) throw new Error("--seed must be a number");
  if (!Number.isFinite(args.materiality) || args.materiality <= 0) {
    throw new Error("--materiality must be a positive number of dollars");
  }
  if (!Number.isFinite(args.samples) || args.samples <= 0) {
    throw new Error("--samples must be a positive number");
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Starting audit run "${args.name}"`);
  console.log(
    `  seed=${args.seed}  materiality=${usd(args.materiality)}  samples=${args.samples}  cycles=${args.cycles.join(", ")}` +
      (process.env.CROSSFIRE_NO_LLM === "1" ? "  (model off)" : ""),
  );

  const started = await prepareRun({
    name: args.name,
    seed: args.seed,
    materiality: args.materiality,
    sampleSize: args.samples,
    cycles: args.cycles,
  });
  const forced = started.sampleCount - args.samples;
  console.log(
    `\nRun #${started.runId}: ${started.sampleCount} samples drawn` +
      (forced > 0 ? ` (${forced} above materiality beyond the target sample size)` : "") +
      `. Running the auditor/accountant loop...\n`,
  );

  const header = `${"sample".padEnd(24)} | ${"status".padEnd(9)} | turns | cites | gaps`;
  console.log(header);
  console.log("-".repeat(header.length));

  const result = await runAudit(started.runId, { onSettled: printOutcome });

  console.log(
    `\nRun #${result.runId} complete: ${result.defended} defended, ${result.gaps} gap` +
      (result.gaps === 1 ? "" : "s") +
      (result.failed > 0 ? `, ${result.failed} failed (left open)` : "") +
      `. Only the gaps need a ruling.`,
  );
  console.log(`Referee screen: /audit/${result.runId}`);

  await sql.end();
  process.exit(result.failed > 0 ? 1 : 0);
}

function printOutcome(outcome: SampleOutcome) {
  const label = `${outcome.type}:${outcome.sampleId}`;
  console.log(
    `${label.padEnd(24)} | ${outcome.status.padEnd(9)} | ${String(outcome.turns).padStart(5)} | ` +
      `${String(outcome.citations).padStart(5)} | ${String(outcome.gaps).padStart(4)}`,
  );
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});

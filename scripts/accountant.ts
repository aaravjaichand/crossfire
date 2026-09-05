/**
 * pnpm accountant <sample> [--json] [--no-llm]
 *
 * Gathers evidence for one sample ("bank:72", "invoice:15", "dodo:92") and
 * prints the citations, the gaps, and the accountant's defense paragraph.
 */
import "./lib/env";
import { sql } from "../src/db";
import {
  defend,
  formatBundle,
  gatherEvidence,
  parseSampleId,
  SAMPLE_ID_HELP,
} from "../src/lib/accountant";

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const noLlm = args.includes("--no-llm");
  const target = args.find((a) => !a.startsWith("--"));

  if (!target) {
    console.error(`Usage: pnpm accountant <sample> [--json] [--no-llm]  (${SAMPLE_ID_HELP})`);
    process.exit(2);
  }

  const sample = parseSampleId(target);
  const bundle = noLlm ? await gatherEvidence(sample) : await defend(sample);
  console.log(json ? JSON.stringify(bundle, null, 2) : formatBundle(bundle));
  await sql.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await sql.end().catch(() => {});
  process.exit(1);
});

/**
 * pnpm engine:latency [--samples N] [--seed N]
 *
 * Measures what the demo actually waits on: the two model calls per sample,
 * timed against the real endpoint with the real prompts, and asserts the two
 * numbers a live demo can be judged on — how long a defense takes, and how
 * often the referee is reading the model's prose instead of the assembled
 * fallback paragraph.
 *
 * Deliberately NOT part of `pnpm engine:check` and NOT wired into any
 * aggregate script. Every other check in this repo is offline, free and
 * deterministic; this one is none of those, because a latency number from a
 * stubbed client would be worthless. Run it when the prompts or the model
 * settings change.
 *
 * Because it is the one check that needs the network, it never fails for the
 * network's sake: an unreachable or unauthorized endpoint prints WARN and
 * exits 0. A FAIL here always means the model answered and the answers were
 * too slow or too often unusable.
 *
 * The sample set is drawn with a fixed seed, so a run before a change and a
 * run after it are measuring the same work and the numbers can be compared.
 *
 * A timeout counts as a data point at the timeout value, not as a gap in the
 * series — pretending a call that never returned simply did not happen is how
 * a latency number ends up lying.
 */
import "@/lib/auditor/load-env";
import { sql } from "@/db";
import { gatherEvidence } from "@/lib/accountant";
import { buildDefensePrompt, DEFENSE_SYSTEM_PROMPT, writeDefense } from "@/lib/accountant/defend";
import { loadSampleDetail } from "@/lib/auditor/detail";
import { phraseQuestion } from "@/lib/auditor/llm";
import { chooseQuestion } from "@/lib/auditor/questions";
import { buildCandidates, filterByCycles, pickSamples } from "@/lib/auditor/sampler";
import { complete, LLM_MODEL, LLM_TIMEOUT_MS } from "@/lib/llm";

/** A defense p95 above this is a demo the audience watches a spinner through. */
const TARGET_DEFENSE_P95_MS = 20_000;
/** Below this share of model-written turns the agents read like a template. */
const TARGET_MODEL_PCT = 80;

type Timing = {
  sample: string;
  citations: number;
  gaps: number;
  promptChars: number;
  questionMs: number;
  defenseMs: number;
  source: "model" | "fallback";
  reason?: string;
};

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
}

/**
 * Exits 0 after saying why nothing was measured. Reserved for the endpoint
 * being unreachable or refusing us — never for a measurement we dislike.
 */
async function warn(reason: string): Promise<never> {
  console.log(`WARN  latency not measured: ${reason}`);
  console.log("WARN  this check needs the live model, so it passes when the model is unavailable.");
  await sql.end().catch(() => {});
  process.exit(0);
}

/**
 * True when the failure is the network or the account rather than the model's
 * output: DNS, refused or reset connections, the client timeout, auth, quota,
 * and proxy-side 5xx. Anything else is a real result and must be allowed to
 * fail the check.
 */
function unavailable(message: string): boolean {
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|network|fetch failed|timed? ?out|aborted|\b(401|403|404|408|429|500|502|503|504)\b|unauthorized|invalid.*api.?key|quota|rate.?limit/i.test(
    message,
  );
}

function parseArgs(argv: string[]) {
  let samples = 5;
  let seed = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--samples" && argv[i + 1]) samples = Number(argv[++i]);
    else if (argv[i] === "--seed" && argv[i + 1]) seed = Number(argv[++i]);
  }
  return { samples, seed };
}

/** Nearest-rank percentile: always a value that actually occurred. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function summarise(label: string, values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  return (
    `${label.padEnd(18)} n=${String(values.length).padStart(3)}  ` +
    `p50=${(percentile(sorted, 50) / 1000).toFixed(1)}s  ` +
    `p95=${(percentile(sorted, 95) / 1000).toFixed(1)}s  ` +
    `max=${(percentile(sorted, 100) / 1000).toFixed(1)}s  ` +
    `mean=${(mean / 1000).toFixed(1)}s`
  );
}

async function main() {
  const { samples: wanted, seed } = parseArgs(process.argv.slice(2));

  if (process.env.CROSSFIRE_NO_LLM === "1" || process.env.CROSSFIRE_LLM_FAIL === "1") {
    await warn("CROSSFIRE_NO_LLM / CROSSFIRE_LLM_FAIL is set, so no model call would be made");
  }
  if (!process.env.TENSORMUX_API_KEY) await warn("TENSORMUX_API_KEY is not set");

  // One cheap call decides whether there is an endpoint to measure at all,
  // before spending five samples' worth of database work finding out.
  try {
    await complete("Reply with the single word ok.", "ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (unavailable(message)) await warn(message);
    throw err;
  }

  const pool = filterByCycles(await buildCandidates(), ["purchases", "cash", "revenue", "payroll"]);
  const picks = pickSamples(pool, seed, wanted);
  console.log(
    `Model ${LLM_MODEL}, client timeout ${(LLM_TIMEOUT_MS / 1000).toFixed(0)}s. ` +
      `${picks.length} samples, seed ${seed}.\n`,
  );

  const timings: Timing[] = [];
  for (const candidate of picks) {
    const ref = { type: candidate.sampleType, id: candidate.sampleId } as const;
    const label = `${candidate.sampleType}:${candidate.sampleId}`;

    const detail = await loadSampleDetail(candidate);
    const { text } = chooseQuestion(candidate, detail);
    const qStart = Date.now();
    await phraseQuestion(text);
    const questionMs = Date.now() - qStart;

    const bundle = await gatherEvidence(ref);
    const promptChars = DEFENSE_SYSTEM_PROMPT.length + buildDefensePrompt(bundle).length;
    const dStart = Date.now();
    const answered = await writeDefense(bundle);
    const defenseMs = Date.now() - dStart;

    const timing: Timing = {
      sample: label,
      citations: bundle.citations.length,
      gaps: bundle.gaps.length,
      promptChars,
      questionMs,
      defenseMs,
      source: answered.defenseSource?.source ?? "fallback",
      reason: answered.defenseSource?.reason,
    };
    timings.push(timing);
    console.log(
      `${label.padEnd(22)} q=${(questionMs / 1000).toFixed(1)}s  d=${(defenseMs / 1000).toFixed(1)}s  ` +
        `${timing.source.padEnd(8)} rows=${String(bundle.citations.length).padStart(2)} ` +
        `prompt=${String(promptChars).padStart(5)}ch` +
        (timing.source === "fallback" ? `  <- ${timing.reason ?? ""}` : ""),
    );
  }

  // The endpoint answered the preflight and then dropped out mid-probe. That
  // is still the network's fault, not the prompts'.
  const dropped = timings.filter((t) => t.source === "fallback" && unavailable(t.reason ?? ""));
  if (timings.length > 0 && dropped.length === timings.length) {
    await warn(`every call failed on the endpoint: ${dropped[0].reason}`);
  }

  const kept = timings.filter((t) => t.source === "model").length;
  const modelPct = (kept / (timings.length || 1)) * 100;
  console.log("");
  console.log(summarise("auditor.question", timings.map((t) => t.questionMs)));
  console.log(summarise("accountant.defense", timings.map((t) => t.defenseMs)));
  const promptChars = timings.map((t) => t.promptChars).sort((a, b) => a - b);
  const rows = timings.map((t) => t.citations).sort((a, b) => a - b);
  console.log(
    `defense prompt:    p50=${percentile(promptChars, 50)}ch  max=${percentile(promptChars, 100)}ch  ` +
      `rows p50=${percentile(rows, 50)} max=${percentile(rows, 100)}`,
  );
  console.log("");

  const defenseP95 = percentile(
    timings.map((t) => t.defenseMs).sort((a, b) => a - b),
    95,
  );
  check(
    `defense p95 under ${TARGET_DEFENSE_P95_MS / 1000}s`,
    timings.length > 0 && defenseP95 < TARGET_DEFENSE_P95_MS,
    `p95 ${(defenseP95 / 1000).toFixed(1)}s over ${timings.length} samples`,
  );
  check(
    `at least ${TARGET_MODEL_PCT}% of defenses are model-written`,
    modelPct >= TARGET_MODEL_PCT,
    `${kept}/${timings.length} kept the model's prose (${modelPct.toFixed(0)}%)`,
  );

  console.log(
    failures === 0
      ? "\nAll latency checks passed."
      : `\n${failures} latency check(s) failed.`,
  );
  await sql.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await sql.end().catch(() => {});
  process.exit(1);
});

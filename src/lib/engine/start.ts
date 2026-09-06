"use server";

/**
 * Starting a run, from the home page form or from the CLI.
 *
 * Two steps, deliberately split:
 *
 *   prepareRun()  Deterministic and fast: score every candidate, apply
 *                 materiality and the cycle filter, draw the sample, and write
 *                 audit_runs + audit_samples + the turn-1 auditor questions in
 *                 one transaction (persist.ts). No model call, so it returns
 *                 quickly and the run screen has something real to show
 *                 immediately.
 *
 *   runAudit()    Everything that talks to a model or takes time: phrasing
 *                 each opening question, the accountant's defense, the
 *                 follow-up loop. Run in the background by startRun().
 *
 * startRun() is the server action: it awaits the first step and kicks off the
 * second without blocking the request, returning the run id so the caller can
 * navigate straight to the run and poll it.
 *
 * This file is a "use server" module, so every export must be an async
 * function. Inputs, defaults, and types live in ./inputs.
 */
import { withSampleCitation } from "@/lib/auditor/citation";
import { loadSampleDetail } from "@/lib/auditor/detail";
import { persistRun, type PreparedSample } from "@/lib/auditor/persist";
import { chooseQuestion } from "@/lib/auditor/questions";
import { buildCandidates, filterByCycles, pickSamples } from "@/lib/auditor/sampler";
import { normalizeRunInput, type StartRunInput, type StartedRun } from "./inputs";
import { runAudit } from "./run";

/**
 * Creates the run and its samples without making a single model call. The run
 * is left in status "running": it is not finished until runAudit() has taken
 * every sample through the accountant.
 */
export async function prepareRun(input: StartRunInput = {}): Promise<StartedRun> {
  const { name, seed, materiality, sampleSize, cycles } = normalizeRunInput(input);

  const pool = filterByCycles(await buildCandidates(), cycles);
  const picks = pickSamples(pool, seed, sampleSize, { materialityCents: materiality });
  if (picks.length === 0) {
    throw new Error(
      `No candidate records for cycles ${cycles.join(", ")}. Seed the database with \`pnpm seed\` first.`,
    );
  }

  // Deterministic template text, cited by code. runAudit() rephrases each of
  // these with the model as it reaches the sample; if it never does, the
  // question standing here is still correct and still carries its citation.
  const prepared: PreparedSample[] = [];
  for (const candidate of picks) {
    const detail = await loadSampleDetail(candidate);
    const { templateId, procedure, text } = chooseQuestion(candidate, detail);
    prepared.push({
      candidate,
      templateId,
      procedure,
      question: withSampleCitation(text, candidate),
    });
  }

  const { runId } = await persistRun({
    name,
    seed,
    samples: prepared,
    materialityCents: materiality,
    sampleSize,
    cycles,
    status: "running",
  });

  return { runId, sampleCount: prepared.length, seed, materiality, sampleSize, cycles };
}

/**
 * Server action. Creates the run, then hands it to the engine without waiting
 * for it: the caller gets a run id back immediately and watches progress on
 * the run screen.
 */
export async function startRun(input: StartRunInput = {}): Promise<StartedRun> {
  const started = await prepareRun(input);
  // Deliberately not awaited. The catch is not optional: an unhandled
  // rejection here would take the process down with it.
  void runAudit(started.runId).catch((err) => {
    console.error(`[engine/start] run #${started.runId} failed:`, err);
  });
  return started;
}

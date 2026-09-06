/**
 * POST /api/runs/[runId]/advance
 *
 * Drives a run forward by one bounded step and reports where it stands.
 *
 * startRun() kicks off the whole loop in the background, which is right
 * locally but not on a host that kills the process when the response ends: a
 * run started from the form there would sit at progress 0 forever. This route
 * is the answer. The client calls it repeatedly until `done`, and each call
 * settles what it can inside a budget that fits comfortably under a
 * serverless response cap.
 *
 * Safe to call concurrently, and safe to call alongside a background loop:
 * every sample is claimed with an atomic UPDATE before any work starts, so
 * overlapping calls divide the samples rather than duplicating them.
 */
import { NextResponse } from "next/server";
import { runAuditStep, STEP_BUDGET_MS, STEP_MAX_SAMPLES } from "@/lib/engine/run";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId: raw } = await params;
  const runId = Number(raw);
  if (!Number.isInteger(runId) || runId <= 0) {
    return NextResponse.json({ error: `Bad run id "${raw}".` }, { status: 400 });
  }

  try {
    const step = await runAuditStep(runId, {
      budgetMs: STEP_BUDGET_MS,
      maxSamples: STEP_MAX_SAMPLES,
    });
    return NextResponse.json(step, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The only thing runAuditStep throws for is a run that does not exist;
    // a failing sample is left open and reported through the step result.
    if (message.includes("does not exist")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    console.error(`[api/runs/${runId}/advance]`, err);
    return NextResponse.json({ error: "Failed to advance the run." }, { status: 500 });
  }
}

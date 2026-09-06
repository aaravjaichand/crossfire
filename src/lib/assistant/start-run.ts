/**
 * The one write in the catalog, kept in its own file so that the handlers the
 * model reaches never import a "use server" module. Called by the API route
 * when a human clicks "Start run" on a persisted proposal, and by nothing
 * else. The parameters were normalized by startRunProposal() and stored on
 * the message; they pass through normalizeRunInput() again inside the engine.
 */
import { startRun } from "@/lib/engine/start";
import { formatMoney } from "@/lib/referee/format";
import type { StartRunDraft, ToolResult } from "./types";

export async function executeStartRun(params: StartRunDraft["params"]): Promise<ToolResult> {
  const started = await startRun({
    name: params.name,
    seed: params.seed,
    materiality: params.materiality,
    sampleSize: params.sampleSize,
    cycles: params.cycles,
  });
  return {
    rows: [
      {
        run: String(started.runId),
        name: params.name,
        sampleCount: started.sampleCount,
        seed: started.seed,
        materiality: formatMoney(started.materiality / 100),
        sampleSize: started.sampleSize,
        cycles: started.cycles.join(", "),
        href: `/audit/${started.runId}`,
      },
    ],
    citations: [
      {
        table: "audit_runs",
        id: started.runId,
        field: "name",
        value: params.name,
        reason: `Started from the assistant with seed ${started.seed}, ${started.sampleCount} samples.`,
      },
    ],
    resolvedRunId: String(started.runId),
    note: "The run is working through its samples; open it to watch.",
  };
}

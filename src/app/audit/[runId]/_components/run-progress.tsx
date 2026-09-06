"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * How long to wait before trying again after a step that did not land. Also
 * the plain refresh interval in that case, so a run being driven by something
 * else still fills in while this client cannot reach the endpoint.
 */
const RETRY_MS = 2000;

/** The shape POST /api/runs/[runId]/advance answers with. */
type AdvanceResult = {
  progress: number;
  sampleCount: number;
  status: string;
  /** Samples settled by this call alone. */
  settled: number;
  done: boolean;
};

/**
 * Drives a running audit forward from the browser, and shows where it is.
 *
 * startRun() kicks the engine off in the background, which works locally but
 * not on a host that kills the process once the response is sent — there, a
 * run started from the form would sit at progress 0 for ever. So this does not
 * merely watch: it POSTs to the advance route, which settles a bounded slice
 * of the run per call, refreshes the page, and goes straight back for the next
 * slice until the run reports `done`.
 *
 * Two things it is careful about:
 *
 *   - Never two steps at once. The route is safe to call concurrently — every
 *     sample is claimed with an atomic UPDATE — but overlapping calls from one
 *     browser buy nothing and cost a request, so a ref gates it.
 *   - A failed POST is not fatal. It falls back to refreshing every 2s and
 *     retrying, so a run being driven by the background loop (or by another
 *     open tab) still fills in on screen.
 */
export function RunProgress({
  runId,
  status,
  progress,
  total,
}: {
  runId: string;
  status?: string;
  progress?: number;
  total?: number;
}) {
  const router = useRouter();
  const running = status === "running";
  // Both shared across effect runs on purpose: they guard the request and the
  // run, not the effect instance.
  const inFlight = useRef(false);
  const finished = useRef<string | null>(null);

  useEffect(() => {
    // The mock run has no audit_runs row and nothing to advance.
    if (!running || !/^\d+$/.test(runId)) return;
    // router.refresh() re-runs this effect. Without this, a run that has just
    // reported `done` would POST again on the refresh that reported it, and
    // that POST would refresh again: a request loop on a finished run.
    if (finished.current === runId) return;

    // Local to this effect run rather than a ref: a fetch left over from a
    // previous run of the effect must not resume the loop for the new one.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function later(ms: number) {
      if (cancelled) return;
      timer = setTimeout(pump, ms);
    }

    async function pump() {
      if (cancelled) return;
      // A previous step is still working. Wait for it rather than opening a
      // second one alongside it.
      if (inFlight.current) {
        later(RETRY_MS);
        return;
      }

      inFlight.current = true;
      let step: AdvanceResult | null = null;
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/advance`, {
          method: "POST",
          cache: "no-store",
        });
        if (res.ok) step = (await res.json()) as AdvanceResult;
      } catch {
        // Offline, or the route is unreachable. The refresh below still shows
        // whatever has settled by other means, and the retry below tries again.
      } finally {
        inFlight.current = false;
      }

      if (cancelled) return;

      if (step) {
        const over = step.done || step.status === "failed";
        // Only refresh when there is something new on screen. A step that
        // settled nothing has changed nothing, and refreshing anyway re-runs
        // this effect for no reason.
        if (step.settled > 0 || over) router.refresh();
        // Nothing left to drive. The refresh above re-renders this with a
        // status that is no longer "running", and the effect tears down.
        if (over) {
          finished.current = runId;
          return;
        }
        // Settled something, so there is more to claim right now: go straight
        // back for the next slice. Settled nothing but not done means every
        // remaining sample is claimed by something else — the background loop
        // locally, or another open tab — and hammering the route would not
        // take one of them off it. Wait instead.
        later(step.settled > 0 ? 0 : RETRY_MS);
        return;
      }

      // The POST did not land. Fall back to a plain 2s refresh so a run being
      // driven by the background loop, or by another open tab, still fills in
      // here, and try the step again on the next tick.
      router.refresh();
      later(RETRY_MS);
    }

    pump();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [running, runId, router]);

  if (status === "failed") {
    return (
      <span className="shrink-0 whitespace-nowrap text-[11.5px] text-danger" role="status">
        <span className="mr-1 font-mono">✕</span>
        Run failed. What it finished is on file below.
      </span>
    );
  }

  if (!running) return null;

  const settled = progress ?? 0;
  const count = total ?? 0;
  const percent = count === 0 ? 0 : Math.round((settled / count) * 100);

  return (
    <span
      className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[11.5px] text-ink-2"
      role="status"
      aria-live="polite"
    >
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-line">
        <span className="block h-full bg-accent transition-[width] duration-500" style={{ width: `${percent}%` }} />
      </span>
      <span className="font-mono num">
        {settled} of {count}
      </span>
      <span>settled</span>
    </span>
  );
}

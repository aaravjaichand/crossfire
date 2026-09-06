"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 2000;

/**
 * While the engine is still working through a run, the page is stale the
 * moment it renders: samples settle one at a time in the background. This
 * refreshes the server components on a timer so the sample list, the coverage
 * bar, and the count below fill in as the run proceeds, and stops the moment
 * the run is no longer running.
 *
 * The thread poll in exchange-panes.tsx covers the open sample's turns. This
 * covers the run as a whole, which that one cannot see once the sample the
 * controller happens to be looking at has settled.
 */
export function RunProgress({
  status,
  progress,
  total,
}: {
  status?: string;
  progress?: number;
  total?: number;
}) {
  const router = useRouter();
  const running = status === "running";

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, router]);

  if (status === "failed") {
    return (
      <span className="text-[11.5px] text-danger" role="status">
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
    <span className="flex items-center gap-2 text-[11.5px] text-ink-2" role="status" aria-live="polite">
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

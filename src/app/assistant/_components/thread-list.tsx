"use client";

import Link from "next/link";
import type { AssistantThreadView } from "@/lib/assistant/types";

/** The left column: every thread, newest first, on the sample list's grid. */
export function ThreadList({
  threads,
  selectedId,
}: {
  threads: AssistantThreadView[];
  selectedId: number | null;
}) {
  return (
    <nav
      aria-label="Threads"
      className="min-h-0 overflow-y-auto rounded-xl border border-line bg-paper shadow-[0_5px_18px_rgba(0,0,0,0.045)]"
    >
      <div className="sticky top-0 z-10 border-b border-line bg-paper px-3.5 py-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] font-medium">Threads</span>
          <span className="font-mono text-[11px] text-ink-3 num">{threads.length}</span>
        </div>
      </div>
      <ul className="space-y-1 p-1.5">
        {threads.map((thread) => {
          const selected = thread.id === selectedId;
          return (
            <li key={thread.id}>
              <Link
                href={`/assistant?thread=${thread.id}`}
                prefetch={false}
                aria-current={selected ? "true" : undefined}
                className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 rounded-lg px-3 py-2.5 transition-colors ${
                  selected ? "bg-accent-soft" : "hover:bg-paper-2"
                }`}
              >
                <span className="truncate text-[12.5px] font-medium" title={thread.title}>
                  {thread.title}
                </span>
                <span className="font-mono text-[11px] text-ink-3 num">{thread.messageCount}</span>
                <span className="truncate text-[11.5px] text-ink-3">
                  {thread.runId ? (thread.runId === "mock" ? "walkthrough" : `run ${thread.runId}`) : "no run"}
                  <span className="mx-1.5 text-line-2">|</span>
                  {relativeTime(thread.updatedAt)}
                </span>
              </Link>
            </li>
          );
        })}
        {threads.length === 0 ? (
          <li className="px-3 py-4 text-[12px] text-ink-3">No threads yet. Ask something to start one.</li>
        ) : null}
      </ul>
    </nav>
  );
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

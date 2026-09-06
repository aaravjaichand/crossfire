"use client";

import Link from "next/link";
import { useState } from "react";
import type { SampleView } from "@/lib/referee/data";
import { formatMoney } from "@/lib/referee/format";
import { MEMORY_META, STATUS_META, TYPE_LABEL, VERDICT_MARK } from "./status";

/**
 * Defaults to the gaps, because those are the only samples a controller has to
 * look at; everything else the accountant and the follow-up policy have
 * already settled. The toggle shows the whole run.
 *
 * A sample carrying its own mark for "resolved by memory" is defended, so it
 * is never in the ruling queue: the controller has already ruled on it, in an
 * earlier run. The mark is there so an auditor reading the list can see which
 * defended samples this run actually proved and which it inherited.
 *
 * "Needs ruling" means a gap with no verdict on it yet, which is what the count
 * beside it has always said. Any verdict takes the row out of the queue,
 * including an exception — that one keeps the status at "gap", so without this
 * it would sit in the queue for the rest of the run looking unhandled. It
 * reappears under Show all carrying its verdict.
 */
export function SampleList({
  runId,
  samples,
  selectedId,
  memoryResolved = [],
  onSelect,
}: {
  runId: string;
  samples: SampleView[];
  selectedId: string;
  /** Sample ids ("invoice:5") the engine settled from run memory. */
  memoryResolved?: string[];
  /**
   * Handles a plain click in place of navigation. Modified clicks (new tab,
   * middle button) fall through to the real link.
   */
  onSelect?: (sampleId: string) => void;
}) {
  const byMemory = new Set(memoryResolved);
  const gaps = samples.filter((s) => s.status === "gap");
  const needsRuling = gaps.filter((s) => !s.ruling);
  // With nothing to rule on, an empty pane would hide the run instead of
  // describing it. The toggle is never disabled: ruling the last gap empties
  // this list, and the toggle is the only way back to the run.
  const [needsRulingOnly, setNeedsRulingOnly] = useState(needsRuling.length > 0);
  const shown = needsRulingOnly ? needsRuling : samples;

  return (
    <nav
      aria-label="Samples"
      className="min-h-0 overflow-y-auto rounded-xl border border-line bg-paper shadow-[0_5px_18px_rgba(0,0,0,0.045)]"
    >
      <div className="sticky top-0 z-10 border-b border-line bg-paper px-3.5 py-2.5">
        <div className="flex items-baseline justify-between">
          <span className="text-[12px] font-medium">
            {needsRulingOnly ? "Needs ruling" : "Samples"}
          </span>
          <span className="font-mono text-[11px] text-ink-3 num">{shown.length}</span>
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-[11px] text-ink-3">
            {gaps.length === 0
              ? "No gaps in this run"
              : `${needsRuling.length} of ${gaps.length} ${gaps.length === 1 ? "gap" : "gaps"} unruled`}
            {byMemory.size > 0 ? (
              <>
                <span className="mx-1.5 text-line-2">|</span>
                <span className="text-accent" title={MEMORY_META.hint}>
                  <span className="font-mono" aria-hidden>
                    {MEMORY_META.mark}
                  </span>{" "}
                  <span className="num">{byMemory.size}</span> by memory
                </span>
              </>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => setNeedsRulingOnly((v) => !v)}
            aria-pressed={!needsRulingOnly}
            className="text-[11px] text-ink-2 underline underline-offset-2 hover:text-ink"
          >
            {needsRulingOnly ? `Show all ${samples.length}` : "Needs ruling only"}
          </button>
        </div>
      </div>
      <ul className="space-y-1 p-1.5">
        {shown.map((sample) => {
          const meta = byMemory.has(sample.id) ? MEMORY_META : STATUS_META[sample.status];
          const verdict = sample.ruling ? VERDICT_MARK[sample.ruling.verdict] : null;
          const selected = sample.id === selectedId;
          return (
            <li key={sample.id}>
              <Link
                href={`/audit/${encodeURIComponent(runId)}?s=${encodeURIComponent(sample.id)}`}
                prefetch={false}
                onClick={(event) => {
                  if (!onSelect || event.defaultPrevented) return;
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                    return;
                  }
                  event.preventDefault();
                  onSelect(sample.id);
                }}
                aria-current={selected ? "true" : undefined}
                className={`grid grid-cols-[16px_minmax(0,1fr)_auto] gap-x-2.5 rounded-lg px-3 py-2.5 transition-colors ${
                  selected ? "bg-accent-soft" : "hover:bg-paper-2"
                }`}
              >
                <span
                  className={`row-span-2 pt-0.5 font-mono text-[13px] leading-none ${meta.text}`}
                  title={`${meta.label}: ${meta.hint}`}
                  aria-label={meta.label}
                >
                  {meta.mark}
                </span>
                <span className="truncate text-[12.5px] font-medium" title={sample.label}>
                  {sample.label}
                </span>
                <span className="font-mono text-[12px] num">{formatMoney(sample.amount)}</span>
                <span className="truncate text-[11.5px] text-ink-3">
                  {TYPE_LABEL[sample.type]} {sample.id.split(":")[1]}
                  {verdict ? (
                    <>
                      <span className="mx-1.5 text-line-2">|</span>
                      <span className={verdict.text}>{verdict.short}</span>
                    </>
                  ) : null}
                </span>
                <span className="font-mono text-[11px] text-ink-3 num">{sample.date}</span>
              </Link>
            </li>
          );
        })}
        {shown.length === 0 ? (
          <li className="px-3 py-4 text-[12px] text-ink-3">
            {samples.length === 0
              ? "This run has no samples."
              : "Nothing left to rule on. Show all to review the run."}
          </li>
        ) : null}
      </ul>
    </nav>
  );
}

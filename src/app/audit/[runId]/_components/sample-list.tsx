"use client";

import Link from "next/link";
import { useState } from "react";
import type { SampleView } from "@/lib/referee/data";
import { formatMoney } from "@/lib/referee/format";
import { STATUS_META, TYPE_LABEL, VERDICT_MARK } from "./status";

/**
 * Defaults to the gaps, because those are the only samples a controller has to
 * look at; everything else the accountant and the follow-up policy have
 * already settled. The toggle shows the whole run.
 *
 * The filter is on status alone. sufficient, needs_more, and accepted_with_note
 * all move the sample off "gap", so ruling one of those does take the row out
 * of the queue — which is the point of a queue. An exception leaves the status
 * at "gap", so those rows stay, and the verdict beside them is the only thing
 * separating a gap that has been ruled on from one that has not.
 */
export function SampleList({
  runId,
  samples,
  selectedId,
}: {
  runId: string;
  samples: SampleView[];
  selectedId: string;
}) {
  const gaps = samples.filter((s) => s.status === "gap");
  // With no gaps there is nothing to rule on, and an empty pane would hide the
  // run instead of describing it. The toggle is never disabled: ruling the last
  // gap empties this list, and the toggle is the only way back to the run.
  const [needsRulingOnly, setNeedsRulingOnly] = useState(gaps.length > 0);
  const shown = needsRulingOnly ? gaps : samples;
  const unruled = gaps.filter((s) => !s.ruling).length;

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
          <span className="text-[11px] text-ink-3">
            {gaps.length === 0
              ? "No gaps in this run"
              : `${unruled} of ${gaps.length} ${gaps.length === 1 ? "gap" : "gaps"} unruled`}
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
          const meta = STATUS_META[sample.status];
          const verdict = sample.ruling ? VERDICT_MARK[sample.ruling.verdict] : null;
          const selected = sample.id === selectedId;
          return (
            <li key={sample.id}>
              <Link
                href={`/audit/${encodeURIComponent(runId)}?s=${encodeURIComponent(sample.id)}`}
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

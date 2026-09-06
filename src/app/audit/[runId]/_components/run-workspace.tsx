"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, type ReactNode } from "react";
import type { VerifiedDraft } from "@/lib/assistant/handoff";
import type { ProposedEntry } from "@/lib/referee/adjustments";
import type { SampleView } from "@/lib/referee/data";
import { parseSampleId } from "@/lib/referee/sample-id";
import { ExchangePanes } from "./exchange-panes";
import { RefereeControls } from "./referee-controls";
import { SampleList } from "./sample-list";

/**
 * Selecting a sample used to be a navigation to ?s=, which re-rendered the
 * whole page on the server: another trip to a database in a different region
 * for data the page already had. Every sample, with its full thread, is in
 * the props, so selection is handled here and the URL is updated with
 * pushState, which the App Router folds into useSearchParams without a fetch.
 * Deep links, the back button, and cmd-click on a row all keep working.
 *
 * The server still decides the opening sample and passes it as fallbackId, so
 * the first paint and the client agree on what is highlighted.
 */
export function RunWorkspace({
  runId,
  runVersion,
  samples,
  entries,
  memoryResolved,
  fallbackId,
  draft,
  headerLead,
  headerMiddle,
}: {
  runId: string;
  runVersion: string;
  samples: SampleView[];
  /** The adjusting entry proposed for each sample's gap, keyed by sample id. */
  entries: Record<string, ProposedEntry>;
  memoryResolved: string[];
  fallbackId: string | null;
  /** An assistant draft verified by the server against this run and a sample. */
  draft?: VerifiedDraft | null;
  headerLead: ReactNode;
  headerMiddle: ReactNode;
}) {
  const searchParams = useSearchParams();
  const requested = searchParams.get("s");
  const selected =
    samples.find((sample) => sample.id === requested) ??
    samples.find((sample) => sample.id === fallbackId) ??
    null;
  const ref = selected ? parseSampleId(selected.id) : null;
  const entry = selected ? entries[selected.id] : undefined;

  const select = useCallback(
    (sampleId: string) => {
      const url = `/audit/${encodeURIComponent(runId)}?s=${encodeURIComponent(sampleId)}`;
      window.history.pushState(null, "", url);
    },
    [runId],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <header className="flex h-12 shrink-0 items-center justify-between gap-6 border-b border-line pl-[var(--shell-header-left,1rem)] pr-4">
        {headerLead}
        {headerMiddle}
        <div className="flex shrink-0 items-center gap-3">
          {selected && ref && entry ? (
            <RefereeControls
              runId={runId}
              sampleType={ref.type}
              sampleId={ref.id}
              entry={entry}
              ruling={selected.ruling}
              draft={draft && draft.sampleRef === selected.id ? draft : undefined}
            />
          ) : (
            <span className="text-[12px] text-ink-3">No sample selected</span>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 overflow-x-auto bg-paper-2 p-3 grid-cols-[16rem_minmax(20rem,1fr)] lg:grid-cols-[17rem_minmax(22rem,1fr)_17rem] xl:grid-cols-[20rem_minmax(26rem,1fr)_21rem]">
        <SampleList
          runId={runId}
          samples={samples}
          selectedId={selected?.id ?? ""}
          memoryResolved={memoryResolved}
          onSelect={select}
        />
        {selected ? (
          <ExchangePanes
            key={`${selected.id}:${selected.status}:${selected.thread.length}`}
            runId={runId}
            sample={selected}
            runVersion={runVersion}
          />
        ) : (
          <div className="col-span-2 grid place-items-center text-[13px] text-ink-3">
            This run has no samples.
          </div>
        )}
      </div>
    </div>
  );
}

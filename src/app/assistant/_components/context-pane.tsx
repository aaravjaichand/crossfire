"use client";

import { CitationCard } from "@/app/_components/citation-card";
import { Prose } from "@/app/_components/prose";
import type { AssistantMessageView } from "@/lib/assistant/types";
import type { RunContext } from "./assistant-workspace";

/** The right column: the run in context, then every row the last answer cited. */
export function ContextPane({
  runContext,
  answer,
}: {
  runContext: RunContext;
  answer?: AssistantMessageView;
}) {
  const citations = answer?.citations ?? [];
  const chip = runContext.runId !== "mock" ? ` [audit_runs#${runContext.runId}]` : "";
  return (
    <section
      aria-label="Citations"
      className="hidden min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-paper shadow-[0_5px_18px_rgba(0,0,0,0.045)] lg:flex"
    >
      <header className="border-b border-line px-4 py-2">
        <div className="text-[12px] font-medium">Citations</div>
        <div className="text-[11.5px] text-ink-3">
          {answer ? `${citations.length} ${citations.length === 1 ? "row" : "rows"} from this answer` : "No answer yet"}
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {runContext.total !== undefined ? (
          <div className="rounded-lg border border-line bg-paper-2 px-3 py-2.5 text-[12px] leading-relaxed">
            <div className="truncate font-medium" title={runContext.name}>
              {runContext.name}
            </div>
            <div className="mt-1 text-ink-2">
              <Prose text={`Coverage ${runContext.coverage ?? 0}%, ${runContext.defended ?? 0} of ${runContext.total} defended${chip}`} />
            </div>
            <div className="text-ink-2">
              <Prose text={`${runContext.gaps ?? 0} ${runContext.gaps === 1 ? "gap" : "gaps"} waiting on a ruling${chip}`} />
            </div>
          </div>
        ) : null}
        {citations.map((c, i) => (
          <CitationCard key={`${c.table}-${c.id}-${c.field}-${i}`} citation={c} />
        ))}
        {answer && citations.length === 0 ? (
          <p className="text-[12px] text-ink-3">The answer cited nothing.</p>
        ) : null}
      </div>
    </section>
  );
}

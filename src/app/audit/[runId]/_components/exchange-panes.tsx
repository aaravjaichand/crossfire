"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { MessageView, SampleView } from "@/lib/referee/data";
import type { Citation } from "@/lib/referee/evidence-types";
import { STATUS_META } from "./status";

const POLL_MS = 2000;

type ThreadResponse = { sample: SampleView; runVersion: string };

/**
 * The thread refetches while the sample is open, so a live accountant run can
 * stream turns in; once the referee rules on it, polling stops.
 *
 * The poll returns a version covering every sample's status and turn count,
 * not just this one. When that changes, the open thread is updated straight
 * away and the server component tree is refreshed as well — otherwise the left
 * pane and the coverage bar would keep showing what they were rendered with,
 * which is exactly the case where another sample has just moved.
 */
export function ExchangePanes({
  runId,
  sample,
  runVersion,
}: {
  runId: string;
  sample: SampleView;
  runVersion: string;
}) {
  const router = useRouter();
  const [live, setLive] = useState(sample);
  const polling = live.status === "open";

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let refreshedFor: string | null = null;
    const url = `/audit/${encodeURIComponent(runId)}/thread?sample=${encodeURIComponent(sample.id)}`;

    async function tick() {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const next: ThreadResponse = await res.json();
        if (cancelled) return;
        setLive(next.sample);
        // Refresh once per distinct version: router.refresh() re-renders this
        // component with fresh props, and re-requesting on every tick would
        // hammer the server for a page that is already current.
        if (next.runVersion !== runVersion && next.runVersion !== refreshedFor) {
          refreshedFor = next.runVersion;
          router.refresh();
        }
      } catch {
        // A failed poll is not worth surfacing; the next tick retries.
      }
    }

    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runId, sample.id, polling, runVersion, router]);

  const latestEvidence = [...live.thread]
    .reverse()
    .find((m) => m.role === "accountant" && m.evidence)?.evidence;
  const meta = STATUS_META[live.status];

  return (
    <>
      <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-paper shadow-[0_5px_18px_rgba(0,0,0,0.045)]">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-2">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{live.label}</div>
            <div className="font-mono text-[11px] text-ink-3 num">
              {live.id}
              <span className="mx-2 text-line-2">|</span>
              {live.date}
              <span className="mx-2 text-line-2">|</span>
              {live.thread.length} {live.thread.length === 1 ? "turn" : "turns"}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-[12px]">
            <span className="flex items-center gap-1.5" title={meta.hint}>
              <span className={`font-mono ${meta.text}`} aria-hidden>
                {meta.mark}
              </span>
              <span>{meta.label}</span>
            </span>
            <span className="text-[11.5px] text-ink-3" aria-live="polite">
              {polling ? "Live" : "Settled"}
            </span>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {live.thread.length === 0 ? (
            <p className="text-[13px] text-ink-3">
              The auditor has not asked anything about this sample yet.
            </p>
          ) : (
            <ol className="max-w-3xl space-y-5">
              {live.thread.map((m) => (
                <li key={`${m.turn}-${m.role}`}>
                  <Message message={m} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section
        aria-label="Evidence"
        className="hidden min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-paper shadow-[0_5px_18px_rgba(0,0,0,0.045)] lg:flex"
      >
        <header className="border-b border-line px-4 py-2">
          <div className="text-[12px] font-medium">Evidence</div>
          <div className="text-[11.5px] text-ink-3">
            {latestEvidence
              ? `${latestEvidence.citations.length} citations from the latest defense`
              : "No accountant turn yet"}
          </div>
        </header>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {latestEvidence?.citations.map((c, i) => (
            <CitationCard key={`${c.table}-${c.id}-${c.field}-${i}`} citation={c} />
          ))}
          {latestEvidence && latestEvidence.citations.length === 0 ? (
            <p className="text-[12px] text-ink-3">The accountant cited nothing.</p>
          ) : null}
        </div>
      </section>
    </>
  );
}

const ROLE_LABEL: Record<string, string> = {
  auditor: "Auditor",
  accountant: "Accountant",
  referee: "Referee",
};

// Transcript layout: who spoke in a fixed column, what they said beside it.
function Message({ message }: { message: MessageView }) {
  const label = ROLE_LABEL[message.role] ?? message.role;
  const isReferee = message.role === "referee";
  return (
    <article className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4">
      <div className="pt-px">
        <div className={`text-[12px] font-medium ${message.role === "accountant" ? "text-ink-2" : "text-ink"}`}>
          {label}
        </div>
        <div className="font-mono text-[11px] text-ink-3 num">turn {message.turn}</div>
      </div>
      <div>
        {message.procedure ? (
          <div className="mb-1 text-[11px] text-ink-3" title="Audit procedure this question came from">
            Procedure · {message.procedure}
          </div>
        ) : null}
        <p className={`text-[13px] leading-relaxed ${isReferee ? "text-ink-2" : "text-ink"}`}>
          <Prose text={message.content} />
        </p>
        {message.evidence && message.evidence.gaps.length > 0 ? (
          <ul className="mt-2.5 space-y-1.5">
            {message.evidence.gaps.map((g, i) => (
              <li
                key={`${g.kind}-${i}`}
                className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg border border-line bg-paper-2 px-3 py-2.5 text-[12px]"
              >
                <span className="font-mono">△</span>
                <span>
                  <span className="font-mono text-[11px] text-ink-2">{g.kind}</span>
                  <span className="ml-2">{g.description}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

// Inline "[table#id]" citations, the same format the accountant and auditor
// write. Marking them up keeps the claim and the row it rests on visibly
// attached, rather than leaving brackets floating in the prose.
const CITATION = /\[[a-z_]+#\d+(?:,\s*(?:[a-z_]+)?#\d+)*\]/g;

function Prose({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(CITATION)) {
    const start = match.index;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <span
        key={`${start}-${match[0]}`}
        className="mx-0.5 rounded-[3px] border border-line bg-paper-2 px-1 py-px font-mono text-[11px] text-ink-2"
      >
        {match[0].slice(1, -1)}
      </span>,
    );
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function CitationCard({ citation }: { citation: Citation }) {
  return (
    <div className="rounded-lg border border-line bg-paper p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11.5px] num">
          {citation.table}#{citation.id}
        </span>
        <span className="font-mono text-[11px] text-ink-3">{citation.field}</span>
      </div>
      <div className="mt-1 break-words font-mono text-[12.5px] num">
        {citation.value === "" ? <span className="text-ink-3">(empty)</span> : citation.value}
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-ink-2">{citation.reason}</p>
      {citation.filePath ? (
        <a
          href={fileUrl(citation.filePath)}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-block font-mono text-[11px] underline underline-offset-2 hover:text-ink-2"
        >
          {citation.filePath.split("/").pop()}
        </a>
      ) : null}
    </div>
  );
}

// file_path values are repo-relative, e.g. "data/invoices/STR-2025-05.pdf".
function fileUrl(filePath: string): string {
  const relative = filePath.replace(/^\/?data\//, "");
  return `/api/files/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

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
 * pane and the coverage ring would keep showing what they were rendered with,
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
      <section className="flex min-h-0 flex-col bg-neutral-950">
        <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2">
          <div className="min-w-0">
            <div className="truncate text-[13px] text-neutral-200">{live.label}</div>
            <div className="font-mono text-[11px] text-neutral-500">
              {live.id} · {live.date} · {live.thread.length} turns
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="flex items-center gap-1.5" title={meta.hint}>
              <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden />
              <span className={`text-[11px] ${meta.text}`}>{meta.label}</span>
            </span>
            <span className="text-[11px] text-neutral-600" aria-live="polite">
              {polling ? "polling every 2s" : "polling stopped"}
            </span>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <ol className="space-y-3">
            {live.thread.map((m) => (
              <li key={`${m.turn}-${m.role}`}>
                <Message message={m} />
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section
        aria-label="Evidence"
        className="flex min-h-0 flex-col border-l border-neutral-800 bg-neutral-950"
      >
        <header className="border-b border-neutral-800 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-neutral-500">Evidence</div>
          <div className="text-[11px] text-neutral-600">
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
            <p className="text-xs text-neutral-500">The accountant cited nothing.</p>
          ) : null}
        </div>
      </section>
    </>
  );
}

const ROLE_STYLE: Record<string, { label: string; accent: string; text: string }> = {
  auditor: { label: "Auditor", accent: "border-l-sky-500/50", text: "text-sky-300" },
  accountant: { label: "Accountant", accent: "border-l-neutral-600", text: "text-neutral-400" },
  referee: { label: "Referee", accent: "border-l-violet-500/50", text: "text-violet-300" },
};

function Message({ message }: { message: MessageView }) {
  const role = ROLE_STYLE[message.role] ?? ROLE_STYLE.accountant;
  return (
    <article className={`border-l-2 pl-3 ${role.accent}`}>
      <div className="flex items-baseline gap-2">
        <span className={`text-[11px] uppercase tracking-wide ${role.text}`}>{role.label}</span>
        <span className="font-mono text-[11px] text-neutral-600">turn {message.turn}</span>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-neutral-300">
        <Prose text={message.content} />
      </p>
      {message.evidence && message.evidence.gaps.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {message.evidence.gaps.map((g, i) => (
            <li
              key={`${g.kind}-${i}`}
              className="rounded border border-amber-900/60 bg-amber-950/20 px-2 py-1.5 text-[12px] text-amber-200/90"
            >
              <span className="font-mono text-[11px] uppercase tracking-wide text-amber-400/80">
                {g.kind}
              </span>
              <span className="ml-2">{g.description}</span>
            </li>
          ))}
        </ul>
      ) : null}
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
        className="mx-0.5 rounded bg-neutral-800/80 px-1 font-mono text-[11px] text-neutral-400"
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
    <div className="rounded border border-neutral-800 bg-neutral-900/40 p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] text-neutral-400">
          {citation.table}#{citation.id}
        </span>
        <span className="font-mono text-[11px] text-neutral-500">{citation.field}</span>
      </div>
      <div className="mt-1 break-words font-mono text-[13px] text-neutral-100">
        {citation.value === "" ? (
          <span className="text-neutral-500">(empty)</span>
        ) : (
          citation.value
        )}
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-neutral-400">{citation.reason}</p>
      {citation.filePath ? (
        <a
          href={fileUrl(citation.filePath)}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-block font-mono text-[11px] text-sky-400 underline underline-offset-2 hover:text-sky-300"
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

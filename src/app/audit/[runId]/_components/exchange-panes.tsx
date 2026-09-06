"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CitationCard } from "@/app/_components/citation-card";
import { Prose } from "@/app/_components/prose";
import type { ChipAsk } from "@/lib/assistant/types";
import type { MessageView, SampleView } from "@/lib/referee/data";
import { MEMORY_MARK, procedureLabel, STATUS_META } from "./status";

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

  const latestAccountant = [...live.thread]
    .reverse()
    .find((m) => m.role === "accountant" && m.evidence);
  const latestEvidence = latestAccountant?.evidence;
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
                  <Message
                    message={m}
                    // Chips only beside the last accountant turn: one beside a
                    // superseded turn would open the assistant on stale evidence.
                    chips={m === latestAccountant ? { runId, sampleId: live.id } : undefined}
                  />
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

// The database role stays "referee" — it is a column value, and renaming it
// would rewrite history that is already on file. Only the label changes, to
// match the binder and the rest of the product.
const ROLE_LABEL: Record<string, string> = {
  auditor: "Auditor",
  accountant: "Accountant",
  referee: "Controller",
};

// A turn the engine wrote from run memory is filed as a fallback like any other
// defense written here, but it was not assembled from the evidence: it repeats a
// ruling the controller already made (buildMemoryTurn in accountant/memory.ts).
// The reason it carries is what separates the two — an ordinary assembled
// defense can cite a consulted learned_rules row of its own, so the citation is
// not on its own enough to tell them apart.
function carriedForward(reason: string | undefined): boolean {
  return (reason ?? "").startsWith("carried forward");
}

// The assistant's openings a gap can hand it. A closed set: the assistant
// page maps each to a fixed question and a named tool, never free text.
const CHIPS: { ask: ChipAsk; label: string }[] = [
  { ask: "explain_gap", label: "Explain this gap" },
  { ask: "draft_accept", label: "Draft an accept-with-note" },
  { ask: "prior_rulings", label: "Similar items in earlier runs" },
];

function chipHref(runId: string, sampleId: string, ask: ChipAsk): string {
  return `/assistant?run=${encodeURIComponent(runId)}&sample=${encodeURIComponent(sampleId)}&ask=${ask}`;
}

// Transcript layout: who spoke in a fixed column, what they said beside it.
function Message({
  message,
  chips,
}: {
  message: MessageView;
  /** Set on the last accountant turn only: where the assistant chips go. */
  chips?: { runId: string; sampleId: string };
}) {
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
            Procedure · {procedureLabel(message.procedure)}
          </div>
        ) : null}
        {/* Only the fallback is worth saying. A model-written defense is the
            normal case, and labelling it would be noise on every turn. */}
        {message.evidence?.defenseSource?.source === "fallback" ? (
          <div
            className="mb-1 text-[11px] text-ink-3"
            title={message.evidence.defenseSource.reason || undefined}
          >
            {carriedForward(message.evidence.defenseSource.reason) ? (
              <>
                <span className="font-mono" aria-hidden>
                  {MEMORY_MARK}
                </span>{" "}
                Carried forward from an earlier ruling
              </>
            ) : (
              "Assembled from evidence"
            )}
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
        {chips && message.evidence && message.evidence.gaps.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {CHIPS.map((chip) => (
              <Link key={chip.ask} className="btn" href={chipHref(chips.runId, chips.sampleId, chip.ask)}>
                {chip.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

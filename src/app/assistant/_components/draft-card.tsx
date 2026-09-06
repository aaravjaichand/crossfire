"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Prose } from "@/app/_components/prose";
import { fileDraft } from "@/lib/assistant/actions";
import type { AssistantMessageView, RulingDraft, StartRunDraft } from "@/lib/assistant/types";
import { formatMoney } from "@/lib/referee/format";
import { REMEDIES, REMEDY_HINT, REMEDY_LABEL, VERDICT_LABEL, type Remedy } from "@/lib/referee/verdicts";

const GENERIC_FAILURE = "The ruling could not be recorded. Try again.";

/**
 * A draft is text for the human. The card lets them edit it, hand it to the
 * run screen, or file it from here through the same server action the run
 * screen's verdict buttons call. Nothing is filed without the click.
 */
export function DraftCard({
  message,
  draft,
  onFiled,
}: {
  message: AssistantMessageView;
  draft: RulingDraft;
  onFiled: (updated: AssistantMessageView) => void;
}) {
  const [note, setNote] = useState(draft.text);
  const [remedy, setRemedy] = useState<Remedy | undefined>(draft.remedy);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fromDraft = note === draft.text && draft.text.length > 0;
  const filed = draft.filedDecisionId;

  const runHref = `/audit/${encodeURIComponent(draft.runId)}?s=${encodeURIComponent(draft.sampleRef)}`;
  const fileLabel =
    draft.verdict === "accepted_with_note"
      ? "File as accepted with note"
      : draft.verdict === "needs_more"
        ? "File as needs more"
        : `File exception · ${remedy ? REMEDY_LABEL[remedy].toLowerCase() : "choose a remedy"}`;

  function file() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await fileDraft({ messageId: message.id, note, remedy });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        onFiled({
          ...message,
          draft: { ...draft, text: note, ...(remedy ? { remedy } : {}), filedDecisionId: result.decisionId },
        });
      } catch {
        setError(GENERIC_FAILURE);
      }
    });
  }

  return (
    <div className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg border border-line bg-paper-2 px-3 py-2.5 text-[12px]">
      <span className="font-mono">{filed ? "✓" : "◆"}</span>
      <div className="min-w-0">
        {filed ? (
          <div>
            <span className="font-medium">Filed</span>
            <span className="mx-1.5 text-line-2">·</span>
            <span className="font-mono text-[11px] num">
              run {draft.runId} · {draft.sampleRef} · referee_decisions#{filed}
            </span>
            <span className="mx-1.5 text-line-2">·</span>
            <Link href={runHref} className="underline underline-offset-2 hover:text-ink-2">
              Open on the run screen
            </Link>
            {note ? (
              <p className="mt-1.5 leading-relaxed text-ink-2">
                <Prose text={note} />
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{VERDICT_LABEL[draft.verdict]}</span>
              <span className="font-mono text-[11px] text-ink-3 num">
                {draft.sampleRef} · run {draft.runId}
              </span>
            </div>
            {fromDraft ? (
              <div className="mt-1 text-[11.5px] text-ink-3">
                <span className="font-mono" aria-hidden>
                  ◆
                </span>{" "}
                Drafted by the assistant — edit before filing.
              </div>
            ) : null}
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={3}
              aria-label={`${VERDICT_LABEL[draft.verdict]} note`}
              placeholder={draft.verdict === "exception" ? "Note (optional)" : "Say what you decided"}
              // .input fixes height at 28px and is unlayered, so the override is inline.
              style={{ height: "auto" }}
              className="input mt-1.5 w-full resize-y py-1.5 text-[12px] leading-relaxed"
            />
            {draft.verdict === "exception" ? (
              <fieldset className="mt-2">
                <legend className="text-[11.5px] text-ink-3">Remedy</legend>
                <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1">
                  {REMEDIES.map((r) => (
                    <label key={r} className="flex items-center gap-2 text-[12px]" title={REMEDY_HINT[r]}>
                      <input
                        type="radio"
                        name={`remedy-${message.id}`}
                        checked={remedy === r}
                        onChange={() => setRemedy(r)}
                        className="accent-[var(--accent)]"
                      />
                      {REMEDY_LABEL[r]}
                    </label>
                  ))}
                </div>
                {draft.entry ? (
                  <p className="mt-1.5 text-[11.5px] leading-snug text-ink-3">
                    Proposed entry: Dr {draft.entry.debit} / Cr {draft.entry.credit} {draft.entry.amount}. Amount is{" "}
                    {draft.entry.amountSource}.
                  </p>
                ) : null}
              </fieldset>
            ) : null}
            {error ? (
              <div className="mt-2 text-[12px] text-ink" role="alert">
                <span className="mr-1 font-mono">△</span>
                {error}
              </div>
            ) : null}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Link className="btn" href={`${runHref}&draft=${message.id}`}>
                Use on the run screen
              </Link>
              <button
                type="button"
                className="btn btn-solid"
                onClick={file}
                disabled={pending || (draft.verdict !== "exception" && note.trim().length === 0) || (draft.verdict === "exception" && !remedy)}
              >
                {pending ? "Filing…" : fileLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** A proposed run. Nothing starts until the click. */
export function StartRunCard({
  draft,
  pending,
  onConfirm,
}: {
  draft: StartRunDraft;
  pending: boolean;
  onConfirm: () => void;
}) {
  const p = draft.params;
  return (
    <div className="mt-2.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 rounded-lg border border-line bg-paper-2 px-3 py-2.5 text-[12px]">
      <span className="font-mono">{draft.startedRunId ? "✓" : "◆"}</span>
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">{draft.startedRunId ? "Started" : "Proposed run"}</span>
          {draft.startedRunId ? (
            <Link href={`/audit/${draft.startedRunId}`} className="font-mono text-[11px] underline underline-offset-2 num">
              run {draft.startedRunId}
            </Link>
          ) : null}
        </div>
        <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[12px]">
          <dt className="text-ink-3">Name</dt>
          <dd className="truncate">{p.name}</dd>
          <dt className="text-ink-3">Seed</dt>
          <dd className="font-mono num">{p.seed}</dd>
          <dt className="text-ink-3">Materiality</dt>
          <dd className="font-mono num">{formatMoney(p.materiality / 100)}</dd>
          <dt className="text-ink-3">Sample size</dt>
          <dd className="font-mono num">{p.sampleSize}</dd>
          <dt className="text-ink-3">Cycles</dt>
          <dd>{p.cycles.join(", ")}</dd>
        </dl>
        {!draft.startedRunId ? (
          <div className="mt-2.5 flex items-center gap-2">
            <button type="button" className="btn btn-solid" onClick={onConfirm} disabled={pending}>
              {pending ? "Starting…" : "Start run"}
            </button>
            <span className="text-[11.5px] text-ink-3">Nothing has started yet.</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

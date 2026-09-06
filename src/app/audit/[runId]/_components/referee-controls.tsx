"use client";

import { useEffect, useState, useTransition } from "react";
import { submitVerdict, type DecisionResult } from "@/lib/referee/actions";
import type { ProposedEntry } from "@/lib/referee/adjustments";
import type { Ruling } from "@/lib/referee/data";
import type { SampleType } from "@/lib/referee/evidence-types";
import {
  REMEDIES,
  REMEDY_HINT,
  REMEDY_LABEL,
  VERDICT_HINT,
  VERDICT_LABEL,
  type Remedy,
  type Verdict,
} from "@/lib/referee/verdicts";

const GENERIC_FAILURE = "The ruling could not be recorded. Try again.";

/**
 * Four verdicts, and the shortest path to each one.
 *
 * sufficient files on the first click. needs_more and accepted_with_note open
 * a single note field and file on submit. exception opens the proposed
 * adjusting entry with the four remedies rendered as buttons: choosing the
 * remedy *is* the ruling, so an exception is two clicks rather than a
 * selection followed by a confirmation.
 *
 * Everything the verdict needs is in a panel anchored under the buttons, so
 * ruling never moves the transcript, the sample list, or the coverage bar.
 */
export function RefereeControls({
  runId,
  sampleType,
  sampleId,
  entry,
  ruling,
}: {
  runId: string;
  sampleType: SampleType;
  sampleId: number;
  /** The adjusting entry proposed for this sample's gap, computed on the server. */
  entry: ProposedEntry;
  ruling?: Ruling;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<Verdict | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Moving to another sample must not carry a half-written note with it.
  useEffect(() => {
    setOpen(null);
    setNote("");
    setError(null);
  }, [runId, sampleType, sampleId]);

  const input = { runId, sampleType, sampleId };

  // The action answers with a result. A refused ruling carries a message
  // written for the controller; a thrown one means the action itself broke,
  // and whatever it says is server detail the controller should not be reading.
  function file(verdict: Verdict, remedy?: Remedy) {
    setError(null);
    startTransition(async () => {
      try {
        const result: DecisionResult = await submitVerdict(input, {
          verdict,
          note,
          remedy,
        });
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setOpen(null);
        setNote("");
      } catch {
        setError(GENERIC_FAILURE);
      }
    });
  }

  function choose(verdict: Verdict) {
    setError(null);
    // Nothing more to ask for: one click and it is on file.
    if (verdict === "sufficient") {
      file(verdict);
      return;
    }
    setNote("");
    setOpen((current) => (current === verdict ? null : verdict));
  }

  return (
    <div className="relative flex items-center gap-2">
      {ruling ? (
        <span className="hidden shrink-0 text-[11.5px] text-ink-3 xl:inline" title="Last ruling on file">
          Ruled {VERDICT_LABEL[ruling.verdict].toLowerCase()}
        </span>
      ) : null}

      {error ? (
        <span className="max-w-64 truncate text-[12px] text-ink" title={error} role="alert">
          <span className="mr-1 font-mono">△</span>
          {error}
        </span>
      ) : null}

      {(["sufficient", "needs_more", "exception", "accepted_with_note"] as Verdict[]).map((v) => (
        <button
          key={v}
          type="button"
          className={v === "sufficient" ? "btn btn-solid" : "btn"}
          aria-expanded={v === "sufficient" ? undefined : open === v}
          title={VERDICT_HINT[v]}
          onClick={() => choose(v)}
          disabled={pending}
        >
          {VERDICT_LABEL[v]}
        </button>
      ))}

      {open === "needs_more" || open === "accepted_with_note" ? (
        <Panel onClose={() => setOpen(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              file(open);
            }}
          >
            <PanelHeading title={VERDICT_LABEL[open]} hint={VERDICT_HINT[open]} />
            <input
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              placeholder={
                open === "needs_more"
                  ? "Tell the accountant where to look"
                  : "Say what you accepted and why"
              }
              aria-label={`${VERDICT_LABEL[open]} note`}
              className="input mt-3 w-full"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setOpen(null)} disabled={pending}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-solid"
                disabled={pending || note.trim().length === 0}
              >
                File ruling
              </button>
            </div>
          </form>
        </Panel>
      ) : null}

      {open === "exception" ? (
        <Panel onClose={() => setOpen(null)}>
          <PanelHeading title="Exception" hint={VERDICT_HINT.exception} />
          <ProposedEntryCard entry={entry} />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Note (optional)"
            aria-label="Exception note"
            className="input mt-3 w-full"
          />
          <div className="mt-3">
            <div className="text-[11.5px] text-ink-3">Choosing a remedy files the exception.</div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              {REMEDIES.map((remedy) => (
                <button
                  key={remedy}
                  type="button"
                  className="btn w-full justify-center"
                  title={REMEDY_HINT[remedy]}
                  onClick={() => file("exception", remedy)}
                  disabled={pending}
                >
                  {REMEDY_LABEL[remedy]}
                </button>
              ))}
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}

function Panel({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="absolute right-0 top-full z-30 mt-2 w-[26rem] rounded-xl border border-line bg-paper p-4 text-left shadow-[0_14px_40px_rgba(0,0,0,0.12)]"
    >
      {children}
    </div>
  );
}

function PanelHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <div className="text-[12.5px] font-medium">{title}</div>
      <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{hint}</p>
    </div>
  );
}

/**
 * The entry comes from the fixed table in src/lib/referee/adjustments.ts, and
 * the rows underneath it are the citations the amount rests on. Showing them
 * together is the point: the controller is approving a number, not a label.
 */
function ProposedEntryCard({ entry }: { entry: ProposedEntry }) {
  return (
    <div className="mt-3 rounded-lg border border-line bg-paper-2 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11.5px] font-medium">Proposed adjusting entry</span>
        <span className="font-mono text-[11px] text-ink-3">{entry.gapKind}</span>
      </div>
      <dl className="mt-2 space-y-1">
        <Leg label="Dr" account={entry.debit} amount={entry.amount} />
        <Leg label="Cr" account={entry.credit} amount={entry.amount} indent />
      </dl>
      <p className="mt-2 text-[11.5px] leading-snug text-ink-2">{entry.memo}</p>
      <p className="mt-1.5 text-[11.5px] leading-snug text-ink-3">
        Amount is {entry.amountSource}.
      </p>
      {entry.basis.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {entry.basis.map((c, i) => (
            <li key={`${c.table}-${c.id}-${c.field}-${i}`} className="font-mono text-[11px] text-ink-2">
              {c.table}#{c.id} · {c.field} = {c.value === "" ? "(empty)" : c.value}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-[11.5px] text-ink-3">
          No citation on file supports this amount; it is the sampled row&apos;s own value.
        </p>
      )}
    </div>
  );
}

function Leg({
  label,
  account,
  amount,
  indent,
}: {
  label: string;
  account: string;
  amount: string;
  indent?: boolean;
}) {
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2">
      <dt className="font-mono text-[11px] text-ink-3">{label}</dt>
      <dd className={`text-[12px] ${indent ? "pl-3" : ""}`}>{account}</dd>
      <dd className="font-mono text-[12px] num">{amount}</dd>
    </div>
  );
}

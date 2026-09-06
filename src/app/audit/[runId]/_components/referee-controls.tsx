"use client";

import { useState, useTransition } from "react";
import { approve, concede, redirect, type DecisionResult } from "@/lib/referee/actions";
import type { SampleType } from "@/lib/referee/evidence-types";

const GENERIC_FAILURE = "The decision could not be recorded. Try again.";

export function RefereeControls({
  runId,
  sampleType,
  sampleId,
}: {
  runId: string;
  sampleType: SampleType;
  sampleId: number;
}) {
  const [pending, startTransition] = useTransition();
  const [showNote, setShowNote] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const input = { runId, sampleType, sampleId };

  // Actions answer with a result. A rejected decision carries a message
  // written for the referee; a thrown one means the action itself broke, and
  // whatever it says is server detail the referee should not be reading.
  function run(action: () => Promise<DecisionResult>) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setShowNote(false);
        setNote("");
      } catch {
        setError(GENERIC_FAILURE);
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      {error ? (
        <span className="max-w-64 truncate text-[12px] text-ink" title={error} role="alert">
          <span className="mr-1 font-mono">△</span>
          {error}
        </span>
      ) : null}

      {showNote ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => redirect(input, note));
          }}
        >
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Tell the accountant where to look"
            aria-label="Redirect note"
            className="input w-72"
          />
          <button type="submit" className="btn btn-solid" disabled={pending || note.trim().length === 0}>
            Send redirect
          </button>
          <button type="button" className="btn" onClick={() => setShowNote(false)} disabled={pending}>
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button type="button" className="btn btn-solid" onClick={() => run(() => approve(input))} disabled={pending}>
            Approve
          </button>
          <button type="button" className="btn" onClick={() => setShowNote(true)} disabled={pending}>
            Redirect
          </button>
          <button type="button" className="btn" onClick={() => run(() => concede(input))} disabled={pending}>
            Concede
          </button>
        </>
      )}
    </div>
  );
}

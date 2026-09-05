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
        <span className="max-w-64 truncate text-xs text-rose-300" title={error} role="alert">
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
            className="h-8 w-72 rounded border border-neutral-700 bg-neutral-900 px-2 text-[13px] text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
          <Button type="submit" disabled={pending || note.trim().length === 0}>
            Send
          </Button>
          <Button type="button" onClick={() => setShowNote(false)} disabled={pending}>
            Cancel
          </Button>
        </form>
      ) : (
        <>
          <Button onClick={() => run(() => approve(input))} disabled={pending}>
            Approve
          </Button>
          <Button onClick={() => setShowNote(true)} disabled={pending}>
            Redirect
          </Button>
          <Button onClick={() => run(() => concede(input))} disabled={pending}>
            Concede
          </Button>
        </>
      )}
    </div>
  );
}

function Button({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) {
  return (
    <button
      {...props}
      className="h-8 rounded border border-neutral-700 bg-neutral-900 px-3 text-[13px] text-neutral-200 transition-colors hover:border-neutral-500 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

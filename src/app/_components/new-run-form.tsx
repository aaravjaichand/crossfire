"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { DEFAULT_MATERIALITY_CENTS, DEFAULT_SAMPLE_SIZE } from "@/lib/engine/inputs";
import { startRun } from "@/lib/engine/start";
import { CYCLES, DEFAULT_CYCLE_IDS } from "@/lib/referee/cycles";

const GENERIC_FAILURE = "The run could not be started. Try again.";
// Both defaults come from the engine, so the form cannot drift from what a run
// started any other way would use. Materiality is $50,000 rather than a
// conventional-looking $5,000 because nothing in these books exceeds $49,900:
// a lower threshold forces almost every record into the run and starves the
// Dodo cycle. Shown in dollars, sent in cents.
const DEFAULT_MATERIALITY = String(DEFAULT_MATERIALITY_CENTS / 100);
// normalizeRunInput falls back to 1 for a missing seed; the field shows the
// same value rather than leaving the controller to guess what they will get.
const DEFAULT_SEED = "1";

/**
 * The whole run configuration inline on the runs list, so starting a run is
 * one button and one Enter. Materiality is typed in dollars and sent in cents,
 * which is what audit_runs.materiality holds.
 */
export function NewRunForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [materiality, setMateriality] = useState(DEFAULT_MATERIALITY);
  const [sampleSize, setSampleSize] = useState(String(DEFAULT_SAMPLE_SIZE));
  const [cycles, setCycles] = useState<string[]>([...DEFAULT_CYCLE_IDS]);
  const [seed, setSeed] = useState(DEFAULT_SEED);

  function toggleCycle(id: string) {
    setCycles((current) =>
      current.includes(id) ? current.filter((c) => c !== id) : [...current, id],
    );
  }

  function submit() {
    setError(null);
    const dollars = Number(materiality);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setError("Materiality must be a positive amount.");
      return;
    }
    startTransition(async () => {
      // startRun throws rather than returning a failure: it draws the sample
      // and writes the run before it returns, and anything that goes wrong in
      // there is a server fault, not a rejected input. The thrown message is
      // not shown — in production Next replaces it with an opaque digest, so
      // it would tell the controller nothing.
      try {
        const started = await startRun({
          name: name.trim(),
          materiality: Math.round(dollars * 100),
          sampleSize: Number(sampleSize),
          cycles,
          seed: Number(seed),
        });
        setOpen(false);
        // The run exists with all its samples by now; the model work runs on
        // behind it, and the run screen polls audit_runs.progress for that.
        router.push(`/audit/${started.runId}`);
      } catch (error) {
        console.error("[new run] starting a run failed", error);
        setError(GENERIC_FAILURE);
      }
    });
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <button type="button" className="btn btn-solid" onClick={() => setOpen(true)}>
          New run
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="w-full rounded-xl border border-line bg-paper p-4 shadow-[0_5px_18px_rgba(0,0,0,0.045)]"
    >
      <div className="flex items-baseline justify-between">
        <div className="text-[13px] font-medium">New run</div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={pending}
          className="text-[11.5px] text-ink-3 underline underline-offset-2 hover:text-ink"
        >
          Cancel
        </button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_7rem_6rem]">
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            placeholder="FY2025 substantive testing"
            className="input w-full"
          />
        </Field>
        <Field label="Materiality">
          <input
            value={materiality}
            onChange={(e) => setMateriality(e.target.value)}
            inputMode="decimal"
            aria-describedby="materiality-unit"
            className="input w-full font-mono num"
          />
        </Field>
        <Field label="Sample size">
          <input
            value={sampleSize}
            onChange={(e) => setSampleSize(e.target.value)}
            inputMode="numeric"
            className="input w-full font-mono num"
          />
        </Field>
        <Field label="Seed">
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            inputMode="numeric"
            className="input w-full font-mono num"
          />
        </Field>
      </div>
      <div id="materiality-unit" className="mt-1 text-[11px] text-ink-3">
        Materiality is in dollars. Every item at or above this amount is always tested.
      </div>

      <fieldset className="mt-3">
        <legend className="text-[11.5px] text-ink-2">Cycles</legend>
        <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5">
          {CYCLES.map((cycle) => (
            <label key={cycle.id} className="flex items-center gap-2 text-[12.5px]">
              <input
                type="checkbox"
                checked={cycles.includes(cycle.id)}
                onChange={() => toggleCycle(cycle.id)}
                className="accent-[var(--accent)]"
              />
              {cycle.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 flex items-center justify-end gap-3">
        {error ? (
          <span className="text-[12px] text-ink" role="alert">
            <span className="mr-1 font-mono">△</span>
            {error}
          </span>
        ) : null}
        <button
          type="submit"
          className="btn btn-solid"
          disabled={pending || name.trim().length === 0 || cycles.length === 0}
        >
          {pending ? "Starting…" : "Start run"}
        </button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11.5px] text-ink-2">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

import Link from "next/link";
import { proposeAdjustment } from "@/lib/referee/adjustments";
import { cycleLabel } from "@/lib/referee/cycles";
import {
  coverage,
  formatMoney,
  getRun,
  latestEvidence,
  parseSampleId,
  primaryGap,
  runVersion,
  type RunView,
  type SampleView,
} from "@/lib/referee/data";
import { CoverageBar } from "./_components/coverage-bar";
import { ExchangePanes } from "./_components/exchange-panes";
import { RefereeControls } from "./_components/referee-controls";
import { SampleList } from "./_components/sample-list";

export const dynamic = "force-dynamic";

export default async function AuditRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ s?: string }>;
}) {
  const { runId } = await params;
  const { s } = await searchParams;

  let run: RunView | null;
  try {
    run = await getRun(runId);
  } catch (error) {
    // The reason belongs in the server log, not on the referee's screen: it
    // carries table names, connection details, and whatever the driver felt
    // like including.
    console.error("[referee] loading run failed", { runId, error });
    return <RunUnavailable runId={runId} />;
  }

  if (!run) return <RunNotFound runId={runId} />;

  const selected = run.samples.find((sample) => sample.id === s) ?? run.samples[0];
  const ref = selected ? parseSampleId(selected.id) : null;
  const { defended, total, percent } = coverage(run);
  // The entry is deterministic and cheap, so it is computed here and handed to
  // the controls as a plain prop rather than fetched when the panel opens.
  const entry = selected ? adjustmentFor(selected) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <header className="flex h-12 shrink-0 items-center justify-between gap-6 border-b border-line pl-[var(--shell-header-left,1rem)] pr-4">
        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="truncate text-[13.5px] font-semibold tracking-tight">{run.name}</h1>
            <span className="shrink-0 font-mono text-[11px] text-ink-3 num">
              {run.kind === "mock" ? "walkthrough" : `run ${run.id}`}
            </span>
          </div>
          <RunParameters run={run} sampleCount={total} />
        </div>

        <div className="hidden md:block">
          <CoverageBar defended={defended} total={total} percent={percent} />
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {selected && ref && entry ? (
            <RefereeControls
              runId={run.id}
              sampleType={ref.type}
              sampleId={ref.id}
              entry={entry}
              ruling={selected.ruling}
            />
          ) : (
            <span className="text-[12px] text-ink-3">No sample selected</span>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 overflow-x-auto bg-paper-2 p-3 grid-cols-[16rem_minmax(20rem,1fr)] lg:grid-cols-[17rem_minmax(22rem,1fr)_17rem] xl:grid-cols-[20rem_minmax(26rem,1fr)_21rem]">
        <SampleList runId={run.id} samples={run.samples} selectedId={selected?.id ?? ""} />
        {selected ? (
          <ExchangePanes
            key={`${selected.id}:${selected.status}:${selected.thread.length}`}
            runId={run.id}
            sample={selected}
            runVersion={runVersion(run)}
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

/**
 * Materiality, sample size, and cycles are Worker A's columns on audit_runs.
 * Until that work lands they read undefined and show an em dash, so the header
 * has the same shape before and after.
 */
function RunParameters({ run, sampleCount }: { run: RunView; sampleCount: number }) {
  const parts = [
    `Materiality ${run.materiality === undefined ? "—" : formatMoney(run.materiality / 100)}`,
    `${run.sampleSize ?? sampleCount} samples`,
    `Cycles ${run.cycles?.map(cycleLabel).join(", ") ?? "—"}`,
  ];
  return (
    <div className="truncate text-[11px] text-ink-3" title={parts.join(" · ")}>
      {parts.join(" · ")}
    </div>
  );
}

/** Never null for a sample: primaryGap falls back to the "other" kind. */
function adjustmentFor(sample: SampleView) {
  const gap = primaryGap(sample);
  return proposeAdjustment({
    gapKind: gap.kind,
    sampleType: sample.type,
    sampleId: Number(sample.id.split(":")[1]),
    sampleAmount: sample.amount,
    citations: latestEvidence(sample)?.citations ?? [],
    gapDescription: gap.description,
  });
}

function RunNotFound({ runId }: { runId: string }) {
  return (
    <Shell title={`There is no audit run ${runId}`}>
      <p className="mt-2 text-[13px] text-ink-2">
        Create one with{" "}
        <code className="rounded-[3px] bg-paper-2 px-1.5 py-0.5 font-mono text-[12px]">
          pnpm auditor:run
        </code>
        , or open the{" "}
        <Link className="underline underline-offset-2" href="/audit/mock">
          walkthrough
        </Link>
        .
      </p>
    </Shell>
  );
}

function RunUnavailable({ runId }: { runId: string }) {
  return (
    <Shell title={`Run ${runId} could not be loaded`}>
      <p className="mt-2 text-[13px] text-ink-2">
        Reading the run failed. The details are in the server log.
      </p>
      <p className="mt-2 text-[13px] text-ink-2">
        On a fresh checkout the tables may not exist yet. Run{" "}
        <code className="rounded-[3px] bg-paper-2 px-1.5 py-0.5 font-mono text-[12px]">
          pnpm db:push
        </code>{" "}
        and{" "}
        <code className="rounded-[3px] bg-paper-2 px-1.5 py-0.5 font-mono text-[12px]">
          pnpm seed
        </code>
        , then reload.
      </p>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-8 py-10">
      <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
      {children}
      <p className="mt-6">
        <Link className="btn" href="/">
          Back to audit runs
        </Link>
      </p>
    </main>
  );
}

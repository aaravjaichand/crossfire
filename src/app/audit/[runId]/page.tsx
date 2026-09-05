import Link from "next/link";
import { coverage, getRun, parseSampleId, runVersion, type RunView } from "@/lib/referee/data";
import { CoverageRing } from "./_components/coverage-ring";
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

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-200">
      <header className="flex shrink-0 items-center justify-between gap-6 border-b border-neutral-800 px-4 py-2">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-medium text-neutral-100">{run.name}</h1>
          <p className="font-mono text-[11px] text-neutral-500">
            run {run.id} · {total} samples
          </p>
        </div>

        <CoverageRing defended={defended} total={total} percent={percent} />

        <div className="flex items-center gap-3">
          {selected && ref ? (
            <>
              <span className="hidden font-mono text-[11px] text-neutral-500 lg:inline">
                acting on {selected.id}
              </span>
              <RefereeControls runId={run.id} sampleType={ref.type} sampleId={ref.id} />
            </>
          ) : (
            <span className="text-[11px] text-neutral-500">No sample selected</span>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[19rem_minmax(0,1fr)_23rem]">
        <SampleList runId={run.id} samples={run.samples} selectedId={selected?.id ?? ""} />
        {selected ? (
          <ExchangePanes
            key={`${selected.id}:${selected.status}:${selected.thread.length}`}
            runId={run.id}
            sample={selected}
            runVersion={runVersion(run)}
          />
        ) : (
          <div className="col-span-2 grid place-items-center text-sm text-neutral-500">
            This run has no samples.
          </div>
        )}
      </div>
    </div>
  );
}

function RunNotFound({ runId }: { runId: string }) {
  return (
    <Shell title={`There is no audit run ${runId}`}>
      <p className="mt-2 text-sm text-neutral-400">
        Run the auditor with <code className="font-mono">pnpm auditor:run</code> to create one, or
        open the walkthrough at{" "}
        <Link className="underline" href="/audit/mock">
          /audit/mock
        </Link>
        .
      </p>
    </Shell>
  );
}

function RunUnavailable({ runId }: { runId: string }) {
  return (
    <Shell title={`Run ${runId} could not be loaded`}>
      <p className="mt-2 text-sm text-neutral-400">
        Something went wrong reading the run. The details are in the server log.
      </p>
      <p className="mt-2 text-sm text-neutral-400">
        If this is a fresh checkout, the tables may not be there yet: run{" "}
        <code className="font-mono">pnpm db:push</code> and{" "}
        <code className="font-mono">pnpm seed</code>, then reload.
      </p>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl p-8 text-neutral-200">
      <h1 className="text-lg font-medium">{title}</h1>
      {children}
      <p className="mt-6 text-sm">
        <Link className="underline" href="/">
          Back to the index
        </Link>
      </p>
    </main>
  );
}

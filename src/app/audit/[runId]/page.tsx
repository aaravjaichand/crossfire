import Link from "next/link";
import { memoryResolvedIds } from "@/lib/accountant/memory";
import { proposeAdjustment } from "@/lib/referee/adjustments";
import { CYCLES, cycleLabel } from "@/lib/referee/cycles";
import {
  coverage,
  formatMoney,
  getRun,
  latestEvidence,
  MOCK_RUN_ID,
  primaryGap,
  resolveRunId,
  runVersion,
  type RunView,
  type SampleView,
} from "@/lib/referee/data";
import { CoverageBar } from "./_components/coverage-bar";
import { RunProgress } from "./_components/run-progress";
import { RunWorkspace } from "./_components/run-workspace";

export const dynamic = "force-dynamic";

export default async function AuditRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;

  let run: RunView | null;
  let memoryResolved: string[];
  try {
    // Which defended samples a controller ruling from an earlier run settled,
    // read from audit_samples.resolution rather than inferred from the
    // transcript. Empty for the walkthrough run, which has no such rows. It
    // only needs the run key, so it does not wait for the run to load.
    const [loaded, resolved] = await Promise.all([getRun(runId), memoryResolvedIds(runKeyOf(runId))]);
    run = loaded;
    memoryResolved = [...resolved];
  } catch (error) {
    // The reason belongs in the server log, not on the referee's screen: it
    // carries table names, connection details, and whatever the driver felt
    // like including.
    console.error("[referee] loading run failed", { runId, error });
    return <RunUnavailable runId={runId} />;
  }

  if (!run) return <RunNotFound runId={runId} />;

  // With no ?s= the screen opens on the work: the first gap the controller has
  // still to rule on, taken in the order the sample list shows them, so the
  // highlighted row is the top of the "Needs ruling" queue rather than whatever
  // the sampler happened to draw first. Then a gap already ruled on, then the
  // first sample of the run.
  const gaps = run.samples.filter((sample) => sample.status === "gap");
  const opening = gaps.find((sample) => !sample.ruling) ?? gaps[0] ?? run.samples[0];
  const { defended, total, percent } = coverage(run);
  // The entries are deterministic and cheap, so they are computed here for
  // every sample and handed down as plain props: switching samples then needs
  // nothing from the server.
  const entries = Object.fromEntries(run.samples.map((sample) => [sample.id, adjustmentFor(sample)]));

  return (
    <RunWorkspace
      key={run.id}
      runId={run.id}
      runVersion={runVersion(run)}
      samples={run.samples}
      entries={entries}
      memoryResolved={memoryResolved}
      fallbackId={opening?.id ?? null}
      headerLead={
        <div key="lead" className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="truncate text-[13.5px] font-semibold tracking-tight">{run.name}</h1>
            <span className="shrink-0 font-mono text-[11px] text-ink-3 num">
              {run.kind === "mock" ? "walkthrough" : `run ${run.id}`}
            </span>
          </div>
          <RunParameters run={run} sampleCount={total} />
        </div>
      }
      headerMiddle={
        <div key="middle" className="hidden shrink-0 items-center gap-4 md:flex">
          <CoverageBar
            defended={defended}
            total={total}
            percent={percent}
            byMemory={memoryResolved.length}
          />
          <RunProgress
            runId={run.id}
            status={run.status}
            progress={run.progress}
            total={run.sampleCount ?? total}
          />
          <Link className="btn" href={`/audit/${encodeURIComponent(run.id)}/binder`}>
            Binder
          </Link>
        </div>
      }
    />
  );
}

/** The key getRun files the run under, before the run itself is loaded. */
function runKeyOf(runId: string): string {
  const resolved = resolveRunId(runId);
  return resolved.kind === "real" ? String(resolved.id) : MOCK_RUN_ID;
}

/**
 * Materiality, sample size, and cycles are Worker A's columns on audit_runs.
 * Until that work lands they read undefined and show an em dash, so the header
 * has the same shape before and after.
 */
function RunParameters({ run, sampleCount }: { run: RunView; sampleCount: number }) {
  const cycles = run.cycles ?? [];
  const head = [
    `Materiality ${run.materiality === undefined ? "—" : formatMoney(run.materiality / 100)}`,
    `${run.sampleCount ?? sampleCount} samples`,
  ];
  // Ids, not names. The full labels run to about 90 characters for the default
  // four, which does not fit this row at any realistic width, and a line cut
  // off at "Cash and b…" tells the controller less than the ids do. The names
  // are on the title for anyone who wants them.
  const shown =
    cycles.length === 0
      ? "Cycles —"
      : cycles.length === CYCLES.length
        ? "All cycles"
        : `Cycles ${cycles.join(", ")}`;
  const full = cycles.length === 0 ? "—" : cycles.map(cycleLabel).join(", ");

  return (
    <div
      className="truncate text-[11px] text-ink-3"
      title={[...head, `Cycles ${full}`].join(" · ")}
    >
      {[...head, shown].join(" · ")}
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

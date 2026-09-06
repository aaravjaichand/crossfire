import Link from "next/link";
import type { RunSummary } from "@/lib/referee/runs";

/** Every run, newest first. The row's coverage is the same defended-over-total the framing shows. */
export function RunsTable({ runs }: { runs: RunSummary[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-ink text-left text-[11.5px] text-ink-2">
            <th className="py-2 pr-4 font-medium">Run</th>
            <th className="py-2 pr-4 font-medium">Created</th>
            <th className="py-2 pr-4 text-right font-medium">Samples</th>
            <th className="py-2 pr-4 text-right font-medium">Defended</th>
            <th className="py-2 pr-4 text-right font-medium">Gaps</th>
            <th className="py-2 pr-4 text-right font-medium">Exceptions</th>
            <th className="py-2 pr-4 text-right font-medium">Open</th>
            <th className="w-40 py-2 font-medium">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const percent = run.total === 0 ? 0 : Math.round((run.defended / run.total) * 100);
            return (
              <tr key={run.id} className="border-b border-line hover:bg-paper-2">
                <td className="max-w-[26rem] py-2.5 pr-4">
                  <Link href={`/audit/${run.id}`} className="flex items-baseline gap-2">
                    <span className="shrink-0 font-mono text-[11.5px] text-ink-3 num">{run.id}</span>
                    <span className="truncate font-medium underline-offset-2 hover:underline" title={run.name}>
                      {run.name}
                    </span>
                  </Link>
                </td>
                <td className="whitespace-nowrap py-2.5 pr-4 font-mono text-[11.5px] text-ink-2 num">
                  {formatDate(run.createdAt)}
                </td>
                <Num value={run.total} />
                <Num value={run.defended} />
                <Num value={run.gap} />
                <Num value={run.exceptions} />
                <Num value={run.open} muted />
                <td className="py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
                      <div className="h-full bg-ink" style={{ width: `${percent}%` }} />
                    </div>
                    <span className="font-mono text-[11.5px] num">{percent}%</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Num({ value, muted }: { value: number; muted?: boolean }) {
  return (
    <td className={`py-2.5 pr-4 text-right font-mono num ${muted ? "text-ink-3" : ""}`}>
      {value}
    </td>
  );
}

export function EmptyRuns() {
  return (
    <div className="rounded-[4px] border border-line px-5 py-6">
      <p className="text-[13px] font-medium">No audit runs yet</p>
      <p className="mt-1 text-[12.5px] text-ink-2">
        Start one with New run above, or from the repo root; either way it appears here and in
        the sidebar.
      </p>
      <pre className="mt-3 inline-block rounded-[4px] bg-paper-2 px-3 py-2 font-mono text-[12px]">
        pnpm auditor:run --seed 1 --name &quot;First pass&quot;
      </pre>
    </div>
  );
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

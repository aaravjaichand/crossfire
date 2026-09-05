import Link from "next/link";
import { formatMoney, type SampleView } from "@/lib/referee/data";
import { STATUS_META, TYPE_LABEL } from "./status";

export function SampleList({
  runId,
  samples,
  selectedId,
}: {
  runId: string;
  samples: SampleView[];
  selectedId: string;
}) {
  return (
    <nav
      aria-label="Samples"
      className="min-h-0 overflow-y-auto border-r border-neutral-800 bg-neutral-950"
    >
      <div className="sticky top-0 z-10 border-b border-neutral-800 bg-neutral-950 px-3 py-2 text-[11px] uppercase tracking-wide text-neutral-500">
        Samples ({samples.length})
      </div>
      <ul>
        {samples.map((sample) => {
          const meta = STATUS_META[sample.status];
          const selected = sample.id === selectedId;
          return (
            <li key={sample.id}>
              <Link
                href={`/audit/${encodeURIComponent(runId)}?s=${encodeURIComponent(sample.id)}`}
                aria-current={selected ? "true" : undefined}
                className={`block border-b border-neutral-900 border-l-2 px-3 py-2 transition-colors ${
                  selected
                    ? "border-l-neutral-400 bg-neutral-900"
                    : "border-l-transparent hover:bg-neutral-900/50"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-wide text-neutral-500">
                    {TYPE_LABEL[sample.type]} {sample.id.split(":")[1]}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-neutral-300">
                    {formatMoney(sample.amount)}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[13px] text-neutral-200" title={sample.label}>
                  {sample.label}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-neutral-500 tabular-nums">
                    {sample.date}
                  </span>
                  <span className="flex items-center gap-1.5" title={meta.hint}>
                    <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} aria-hidden />
                    <span className={`text-[11px] ${meta.text}`}>{meta.label}</span>
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

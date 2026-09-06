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
      className="min-h-0 overflow-y-auto rounded-xl border border-line bg-paper shadow-[0_5px_18px_rgba(0,0,0,0.045)]"
    >
      <div className="sticky top-0 z-10 flex items-baseline justify-between border-b border-line bg-paper px-3.5 py-2.5">
        <span className="text-[12px] font-medium">Samples</span>
        <span className="font-mono text-[11px] text-ink-3 num">{samples.length}</span>
      </div>
      <ul className="space-y-1 p-1.5">
        {samples.map((sample) => {
          const meta = STATUS_META[sample.status];
          const selected = sample.id === selectedId;
          return (
            <li key={sample.id}>
              <Link
                href={`/audit/${encodeURIComponent(runId)}?s=${encodeURIComponent(sample.id)}`}
                aria-current={selected ? "true" : undefined}
                className={`grid grid-cols-[16px_minmax(0,1fr)_auto] gap-x-2.5 rounded-lg px-3 py-2.5 transition-colors ${
                  selected
                    ? "bg-accent-soft"
                    : "hover:bg-paper-2"
                }`}
              >
                <span
                  className={`row-span-2 pt-0.5 font-mono text-[13px] leading-none ${meta.text}`}
                  title={`${meta.label}: ${meta.hint}`}
                  aria-label={meta.label}
                >
                  {meta.mark}
                </span>
                <span className="truncate text-[12.5px] font-medium" title={sample.label}>
                  {sample.label}
                </span>
                <span className="font-mono text-[12px] num">{formatMoney(sample.amount)}</span>
                <span className="text-[11.5px] text-ink-3">
                  {TYPE_LABEL[sample.type]} {sample.id.split(":")[1]}
                </span>
                <span className="font-mono text-[11px] text-ink-3 num">{sample.date}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

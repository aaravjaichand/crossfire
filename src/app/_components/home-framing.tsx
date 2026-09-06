import Link from "next/link";
import { MEMORY_META, STATUS_META } from "@/app/audit/[runId]/_components/status";
import type { RunComparison } from "@/lib/engine/comparison";
import type { RunSummary } from "@/lib/referee/runs";

/**
 * The top of the home page: what Crossfire is, who the three parties are, and
 * the latest run's numbers. A judge opening the URL cold should get the
 * product from this block alone; the runs table below is the record.
 *
 * Every figure is read from the same helpers the table and the comparison
 * panel use, so the three never disagree about a run.
 */
export function HomeFraming({
  latest,
  byMemory,
  comparison,
}: {
  /** The newest run, or null on an empty database. */
  latest: RunSummary | null;
  /** Of the latest run's defended samples, how many a remembered ruling settled. */
  byMemory: number;
  comparison: RunComparison | null;
}) {
  return (
    <header>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="text-[20px] font-semibold tracking-tight">Crossfire</h1>
        <span className="text-[12px] text-ink-3">
          Northwind Labs, FY2025 · pre-audit substantive testing
        </span>
      </div>
      <p className="mt-2 max-w-[64ch] text-pretty text-[13px] leading-relaxed text-ink-2">
        Two agents test the books and a person rules only on what they cannot settle between
        them. Every answer cites a row in the books, and every ruling is remembered, so the
        next run starts where this one ended.
      </p>

      <div className="mt-6 grid gap-x-14 gap-y-7 border-t border-line pt-5 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <Roles />
        <LatestRun latest={latest} byMemory={byMemory} comparison={comparison} />
      </div>
    </header>
  );
}

const ROLES: [string, string][] = [
  [
    "Auditor",
    "Samples the books risk-weighted and demands evidence for each pick: three-way match, cutoff, bank rec, revenue tie-out.",
  ],
  [
    "Accountant",
    "Searches invoices, contracts, the bank feed, Dodo Payments, and the ledger. Cites rows or admits the gap.",
  ],
  [
    "Controller",
    "A person. Rules on what escalates: sufficient, needs more, accepted with note, or exception with a remedy. Rulings become memory.",
  ],
];

function Roles() {
  return (
    <dl className="space-y-3">
      {ROLES.map(([name, what]) => (
        <div key={name} className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 text-[12.5px]">
          <dt className="font-medium">{name}</dt>
          <dd className="text-pretty leading-snug text-ink-2">{what}</dd>
        </div>
      ))}
    </dl>
  );
}

function LatestRun({
  latest,
  byMemory,
  comparison,
}: {
  latest: RunSummary | null;
  byMemory: number;
  comparison: RunComparison | null;
}) {
  const total = latest?.total ?? 0;
  const defended = latest?.defended ?? 0;
  const percent = total === 0 ? 0 : Math.round((defended / total) * 100);
  const memoryPercent = total === 0 ? 0 : Math.round((byMemory / total) * 100);
  const provenPercent = Math.max(0, percent - memoryPercent);

  // The comparison pairs the newest settled run with the last one drawn from
  // the same inputs. It only speaks for this block when that run is the one
  // shown here; otherwise the panel below carries the comparison on its own.
  const delta =
    latest && comparison && comparison.latest.id === latest.id
      ? { pts: comparison.latest.coverage - comparison.previous.coverage, since: comparison.previous.id }
      : null;

  return (
    <section aria-labelledby="latest-run-heading">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="latest-run-heading" className="shrink-0 text-[12.5px] font-medium">
          Latest run
        </h2>
        {latest ? (
          <Link
            href={`/audit/${latest.id}`}
            className="min-w-0 truncate text-[11.5px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
            title={latest.name}
          >
            <span className="font-mono num">run {latest.id}</span> · {latest.name} ·{" "}
            <span className="font-mono num">{formatDate(latest.createdAt)}</span>
          </Link>
        ) : (
          <span className="text-[11.5px] text-ink-3">None yet</span>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-x-6 gap-y-5">
        <Figure label="Samples" value={latest ? total : null} />
        <Figure label="Defended" mark={STATUS_META.defended} value={latest ? defended : null} />
        <Figure label="Gaps waiting" mark={STATUS_META.gap} value={latest ? latest.gap : null} />
        <Figure
          label="Exceptions"
          mark={STATUS_META.conceded}
          value={latest ? latest.exceptions : null}
        />
        <Figure label="By memory" mark={MEMORY_META} value={latest ? byMemory : null} />
        <Figure label="Coverage" value={latest ? `${percent}%` : null} />
      </dl>

      <div
        className="mt-4 flex h-1.5 w-full overflow-hidden rounded-full bg-line"
        role="img"
        aria-label={
          latest
            ? `Coverage ${percent} percent, ${defended} of ${total} samples defended` +
              (byMemory > 0 ? `, ${byMemory} of them resolved by memory` : "")
            : "No coverage yet"
        }
      >
        <div className="h-full bg-accent" style={{ width: `${provenPercent}%` }} />
        <div className="h-full bg-accent/40" style={{ width: `${memoryPercent}%` }} />
      </div>
      <p className="mt-1.5 text-[11.5px] text-ink-3">
        {latest ? (
          <>
            <span className="num">
              {defended} of {total} defended
            </span>
            {byMemory > 0 ? (
              <>
                , <span className="num">{byMemory}</span> of them by memory
              </>
            ) : null}
            {latest.open > 0 ? (
              <>
                {" "}
                · <span className="num">{latest.open}</span> still with the accountant
              </>
            ) : null}
            {delta ? (
              <>
                {" "}
                ·{" "}
                <span className={delta.pts > 0 ? "text-accent" : ""}>
                  {delta.pts === 0
                    ? "no change"
                    : `${delta.pts > 0 ? "+" : "−"}${Math.abs(delta.pts)} pts`}{" "}
                  since <span className="num">run {delta.since}</span>
                </span>
              </>
            ) : null}
          </>
        ) : (
          "The first run's figures appear here. Start one below."
        )}
      </p>
    </section>
  );
}

function Figure({
  label,
  mark,
  value,
}: {
  label: string;
  mark?: { mark: string; text: string; label: string };
  /** null renders an em dash: there is no run to read from yet. */
  value: number | string | null;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-baseline gap-1.5 whitespace-nowrap text-[11.5px] text-ink-2">
        {mark ? (
          <span className={`font-mono ${mark.text}`} aria-hidden title={mark.label}>
            {mark.mark}
          </span>
        ) : null}
        {label}
      </dt>
      <dd className={`mt-1 font-mono text-[20px] leading-none num ${value === null ? "text-ink-3" : ""}`}>
        {value === null ? "—" : value}
      </dd>
    </div>
  );
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

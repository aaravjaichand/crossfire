import Link from "next/link";
import { MEMORY_MARK } from "@/app/audit/[runId]/_components/status";
import type { RecurringItem, RunComparison, RunSide } from "@/lib/engine/comparison";

/**
 * The last two runs of the same books, side by side, above the runs table.
 * It exists because the claim the product makes — the second pass is better
 * than the first because a person ruled on the first — is a number, and a
 * number should be shown rather than described.
 *
 * Everything here is read from audit_samples: coverage is defended over total,
 * and "resolved by memory" is the resolution column the engine wrote, so the
 * panel cannot say something the run does not.
 */
export function RunComparisonPanel({ comparison }: { comparison: RunComparison }) {
  const { previous, latest, recurring, recurringTotal } = comparison;
  const delta = latest.coverage - previous.coverage;

  return (
    <div className="w-full rounded-xl border border-line bg-paper p-4 shadow-[0_5px_18px_rgba(0,0,0,0.045)]">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[13px] font-medium">Since the last run</h2>
        <div className="flex items-baseline gap-2 text-[11.5px] text-ink-3">
          <RunLink run={previous} />
          <span aria-hidden>→</span>
          <RunLink run={latest} />
        </div>
      </div>
      <p className="mt-0.5 text-[12px] text-ink-3">
        Same books. Every ruling the controller filed on{" "}
        <span className="num">run {previous.id}</span> was on the accountant&apos;s desk for{" "}
        <span className="num">run {latest.id}</span>.
      </p>

      <div className="mt-3 grid gap-x-8 gap-y-4 md:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        <dl className="space-y-2">
          <Row
            label="Coverage"
            before={`${previous.coverage}%`}
            after={`${latest.coverage}%`}
            delta={delta === 0 ? null : `${delta > 0 ? "+" : ""}${delta} pts`}
            good={delta > 0}
          />
          <Row
            label="Gaps left"
            before={String(previous.gaps)}
            after={String(latest.gaps)}
            delta={null}
            good={latest.gaps < previous.gaps}
          />
          <Row
            label="Resolved by memory"
            mark
            before={String(previous.resolvedByMemory)}
            after={String(latest.resolvedByMemory)}
            delta={null}
            good={latest.resolvedByMemory > previous.resolvedByMemory}
          />
          <Row
            label="Samples"
            before={String(previous.total)}
            after={String(latest.total)}
            delta={null}
            good={false}
          />
        </dl>

        <div>
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-[12px] font-medium">Items that recurred</h3>
            <span className="font-mono text-[11px] text-ink-3 num">{recurringTotal}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-ink-3">
            Sampled by both runs, and left unsettled by run {previous.id}.
          </p>
          {recurring.length === 0 ? (
            <p className="mt-2 text-[12px] text-ink-3">
              Run {previous.id} left nothing unsettled for run {latest.id} to meet again.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {recurring.map((item) => (
                <RecurringRow key={item.id} item={item} runId={latest.id} />
              ))}
              {recurringTotal > recurring.length ? (
                <li className="px-1 pt-1 text-[11.5px] text-ink-3">
                  and {recurringTotal - recurring.length} more
                </li>
              ) : null}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function RunLink({ run }: { run: RunSide }) {
  return (
    <Link
      href={`/audit/${run.id}`}
      className="max-w-[14rem] truncate underline-offset-2 hover:text-ink hover:underline"
      title={run.name}
    >
      <span className="num">run {run.id}</span>
    </Link>
  );
}

function Row({
  label,
  before,
  after,
  delta,
  good,
  mark,
}: {
  label: string;
  before: string;
  after: string;
  delta: string | null;
  good: boolean;
  mark?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5">
      <dt className="flex items-baseline gap-1.5 text-[12.5px] text-ink-2">
        {mark ? (
          <span className="font-mono text-[12px] text-accent" aria-hidden>
            {MEMORY_MARK}
          </span>
        ) : null}
        {label}
      </dt>
      <dd className="flex items-baseline gap-2 font-mono text-[12.5px] num">
        <span className="text-ink-3">{before}</span>
        <span className="text-ink-3" aria-hidden>
          →
        </span>
        <span className={good ? "font-medium text-accent" : "font-medium"}>{after}</span>
        {delta ? (
          <span className={`text-[11.5px] ${good ? "text-accent" : "text-ink-3"}`}>{delta}</span>
        ) : null}
      </dd>
    </div>
  );
}

const STATUS_WORD: Record<string, string> = {
  open: "still open",
  defended: "defended",
  gap: "gap",
  conceded: "conceded",
};

function RecurringRow({ item, runId }: { item: RecurringItem; runId: number }) {
  const after = item.resolvedByMemory
    ? "resolved by memory"
    : (STATUS_WORD[item.after] ?? item.after);
  return (
    <li>
      <Link
        href={`/audit/${runId}?s=${encodeURIComponent(item.id)}`}
        className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-baseline gap-x-2.5 rounded-lg px-1.5 py-1 hover:bg-paper-2"
      >
        <span
          className={`font-mono text-[12px] leading-none ${item.resolvedByMemory ? "text-accent" : "text-warning"}`}
          aria-hidden
        >
          {item.resolvedByMemory ? MEMORY_MARK : "△"}
        </span>
        <span className="truncate text-[12.5px]">
          <span className="font-medium">{item.counterparty}</span>
          <span className="text-ink-3"> · {item.id.replace(":", " ")}</span>
        </span>
        <span className="whitespace-nowrap text-[11.5px] text-ink-3">
          {STATUS_WORD[item.before] ?? item.before}{" "}
          <span aria-hidden>→</span>{" "}
          <span className={item.resolvedByMemory ? "text-accent" : ""}>{after}</span>
        </span>
      </Link>
    </li>
  );
}

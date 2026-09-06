import { MEMORY_MARK } from "./status";

/**
 * Coverage is defended over sampled, and a sample settled by a controller's
 * earlier ruling is defended — the work was done, once, by a person. It is
 * still worth separating: the lighter part of the bar is the coverage this run
 * inherited rather than proved, so a reader can see at a glance how much of the
 * score is memory.
 */
export function CoverageBar({
  defended,
  total,
  percent,
  byMemory = 0,
}: {
  defended: number;
  total: number;
  percent: number;
  /** Of `defended`, the samples resolved from run memory. */
  byMemory?: number;
}) {
  const memoryPercent = total === 0 ? 0 : Math.round((byMemory / total) * 100);
  const provenPercent = Math.max(0, percent - memoryPercent);

  return (
    <div
      className="flex items-center gap-3"
      role="img"
      aria-label={
        `Coverage ${percent} percent, ${defended} of ${total} samples defended` +
        (byMemory > 0 ? `, ${byMemory} of them resolved by memory` : "")
      }
    >
      <div className="flex h-1.5 w-36 overflow-hidden rounded-full bg-line">
        <div
          className="h-full bg-accent transition-[width] duration-300"
          style={{ width: `${provenPercent}%` }}
        />
        <div
          className="h-full bg-accent/40 transition-[width] duration-300"
          style={{ width: `${memoryPercent}%` }}
        />
      </div>
      <div className="whitespace-nowrap text-[12px] num">
        <span className="font-medium">{percent}%</span>
        <span className="text-ink-2"> coverage, {defended} of {total} defended</span>
        {byMemory > 0 ? (
          <span className="text-accent" title="Resolved by memory: closed by the controller's ruling on an earlier run">
            {" "}
            <span className="font-mono" aria-hidden>
              {MEMORY_MARK}
            </span>{" "}
            {byMemory} by memory
          </span>
        ) : null}
      </div>
    </div>
  );
}

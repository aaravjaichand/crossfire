export function CoverageBar({
  defended,
  total,
  percent,
}: {
  defended: number;
  total: number;
  percent: number;
}) {
  return (
    <div
      className="flex items-center gap-3"
      role="img"
      aria-label={`Coverage ${percent} percent, ${defended} of ${total} samples defended`}
    >
      <div className="h-1.5 w-36 overflow-hidden rounded-full bg-line">
        <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${percent}%` }} />
      </div>
      <div className="whitespace-nowrap text-[12px] num">
        <span className="font-medium">{percent}%</span>
        <span className="text-ink-2"> coverage, {defended} of {total} defended</span>
      </div>
    </div>
  );
}

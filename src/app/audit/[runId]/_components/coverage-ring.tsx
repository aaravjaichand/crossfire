export function CoverageRing({
  defended,
  total,
  percent,
}: {
  defended: number;
  total: number;
  percent: number;
}) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const filled = (percent / 100) * circumference;

  return (
    <div className="flex items-center gap-3">
      <svg
        width="48"
        height="48"
        viewBox="0 0 48 48"
        role="img"
        aria-label={`Coverage ${percent} percent, ${defended} of ${total} samples defended`}
      >
        <circle
          cx="24"
          cy="24"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          className="text-neutral-800"
        />
        <circle
          cx="24"
          cy="24"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="butt"
          strokeDasharray={`${filled} ${circumference - filled}`}
          transform="rotate(-90 24 24)"
          className="text-emerald-500/80"
        />
        <text
          x="24"
          y="24"
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-neutral-200 text-[11px] font-medium tabular-nums"
        >
          {percent}%
        </text>
      </svg>
      <div className="leading-tight">
        <div className="text-[11px] uppercase tracking-wide text-neutral-500">Coverage</div>
        <div className="text-xs text-neutral-400 tabular-nums">
          {defended} of {total} defended
        </div>
      </div>
    </div>
  );
}

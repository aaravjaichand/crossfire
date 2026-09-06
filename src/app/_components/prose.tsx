// Inline "[table#id]" citations, the same format the accountant, the auditor,
// and the assistant write. Marking them up keeps the claim and the row it
// rests on visibly attached, rather than leaving brackets floating in the
// prose. Shared by the run screen's transcript and the assistant so the chip
// is identical in both.
export const CITATION = /\[[a-z_]+#\d+(?:,\s*(?:[a-z_]+)?#\d+)*\]/g;

export function Prose({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(CITATION)) {
    const start = match.index;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <span
        key={`${start}-${match[0]}`}
        className="mx-0.5 rounded-[3px] border border-line bg-paper-2 px-1 py-px font-mono text-[11px] text-ink-2"
      >
        {match[0].slice(1, -1)}
      </span>,
    );
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

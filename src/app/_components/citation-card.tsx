import type { Citation } from "@/lib/accountant/types";

// One evidence row: the table and id, the field cited, its value, why it
// supports the claim, and the document behind it when there is one. Shared
// by the run screen's evidence pane and the assistant's citations pane.
export function CitationCard({ citation }: { citation: Citation }) {
  return (
    <div className="rounded-lg border border-line bg-paper p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11.5px] num">
          {citation.table}#{citation.id}
        </span>
        <span className="font-mono text-[11px] text-ink-3">{citation.field}</span>
      </div>
      <div className="mt-1 break-words font-mono text-[12.5px] num">
        {citation.value === "" ? <span className="text-ink-3">(empty)</span> : citation.value}
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-ink-2">{citation.reason}</p>
      {citation.filePath ? (
        <a
          href={fileUrl(citation.filePath)}
          target="_blank"
          rel="noreferrer"
          className="mt-1.5 inline-block font-mono text-[11px] underline underline-offset-2 hover:text-ink-2"
        >
          {citation.filePath.split("/").pop()}
        </a>
      ) : null}
    </div>
  );
}

// file_path values are repo-relative, e.g. "data/invoices/STR-2025-05.pdf".
export function fileUrl(filePath: string): string {
  const relative = filePath.replace(/^\/?data\//, "");
  return `/api/files/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

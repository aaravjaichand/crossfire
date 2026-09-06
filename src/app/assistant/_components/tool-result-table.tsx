"use client";

import Link from "next/link";
import type { AssistantToolResult } from "@/lib/assistant/types";

const HIDDEN = new Set(["href"]);
const TABLE_BY_PREFIX: Record<string, string> = {
  invoice: "invoices",
  bank: "bank_transactions",
  dodo: "dodo_transactions",
};

/**
 * The rows exactly as a tool returned them, one column per field, with the
 * row's table#id in a monospace first column. What the controller sees when
 * the model's paragraph did not check out, and what CROSSFIRE_NO_LLM=1
 * always produces.
 */
export function ToolResultTable({ result }: { result: AssistantToolResult }) {
  if (result.error) {
    return (
      <div className="text-[12px] text-ink" role="alert">
        <span className="mr-1 font-mono">△</span>
        {result.error}
      </div>
    );
  }
  if (result.rows.length === 0) {
    return <div className="text-[12px] text-ink-3">{result.note ?? "No rows."}</div>;
  }
  const columns = [...new Set(result.rows.flatMap((row) => Object.keys(row)))].filter((k) => !HIDDEN.has(k));
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full border-collapse text-[11.5px]">
        <thead>
          <tr className="border-b border-line bg-paper-2 text-left text-ink-2">
            <th className="px-2 py-1.5 font-mono font-normal">row</th>
            {columns.map((c) => (
              <th key={c} className="px-2 py-1.5 font-medium">
                {c.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => {
            const ref = rowRef(result, row, i);
            const href = typeof row.href === "string" ? row.href : undefined;
            return (
              <tr key={i} className="border-b border-line last:border-b-0 align-top">
                <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-ink-2 num">
                  {href ? (
                    <Link href={href} className="underline underline-offset-2 hover:text-ink">
                      {ref}
                    </Link>
                  ) : (
                    ref
                  )}
                </td>
                {columns.map((c) => (
                  <td key={c} className="max-w-[24rem] px-2 py-1.5" title={cell(row[c])}>
                    <span className="line-clamp-3 break-words">{cell(row[c])}</span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {result.note ? <div className="border-t border-line px-2 py-1.5 text-[11.5px] text-ink-3">{result.note}</div> : null}
    </div>
  );
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The table#id a row rests on, read off the row where it names one. */
function rowRef(result: AssistantToolResult, row: Record<string, unknown>, index: number): string {
  const source = row.source;
  if (typeof source === "string" && /^[a-z_]+#\d+$/.test(source)) return source;
  const sample = typeof row.sample === "string" ? row.sample : undefined;
  if (sample) {
    const [prefix, id] = sample.split(":");
    const table = TABLE_BY_PREFIX[prefix];
    if (table && id) return `${table}#${id}`;
  }
  const run = row.run;
  if (typeof run === "string" && /^\d+$/.test(run)) return `audit_runs#${run}`;
  const c = result.citations[index];
  return c ? `${c.table}#${c.id}` : "—";
}

/**
 * The model writes, then code checks. Same order as finalizeDefense() in
 * src/lib/accountant/citations.ts, with one check added for an assistant that
 * talks about money: every number in the prose must have come out of a tool.
 *
 * On failure the prose is discarded. The message renders as the rows exactly
 * as returned, under a one-line deterministic lede built here from the same
 * rows, so the controller always gets the evidence and a failed check costs
 * only the paragraph.
 */
import { keepOnlyCitedRows, validateDefense } from "@/lib/accountant/citations";
import type { Citation, EvidenceBundle } from "@/lib/accountant/types";
import type { AssistantToolResult } from "./types";

export type FinalAnswer = {
  content: string;
  source: "model" | "fallback";
  /** Why the model's paragraph was rejected, when it was. Logged, never shown. */
  reason?: string;
  citations: Citation[];
};

/**
 * Step 1: every citation returned this turn, as the bundle shape the
 * accountant's checker already takes. The sample on it is a placeholder; the
 * checker reads only `citations`.
 */
export function toolResultsToBundle(results: AssistantToolResult[]): EvidenceBundle {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const r of results) {
    for (const c of r.citations ?? []) {
      const key = `${c.table}#${c.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push(c);
    }
  }
  return { sample: { type: "invoice", id: 0 }, citations, gaps: [] };
}

/**
 * Step 3: the number allowlist. Every digit run in the JSON-serialized tool
 * results, plus the counts of rows and citations (a model saying "4 gaps" over
 * four rows is reading, not computing), plus anything the controller typed.
 * Normalized by stripping "$", thousands separators, and a trailing ".00".
 */
export function numberAllowlist(results: AssistantToolResult[], question?: string): Set<string> {
  const allowed = new Set<string>();
  const sources: string[] = results.map((r) => JSON.stringify({ args: r.args, rows: r.rows, citations: r.citations, note: r.note, resolvedRunId: r.resolvedRunId }));
  for (const r of results) {
    allowed.add(String(r.rows.length));
    allowed.add(String(r.citations.length));
  }
  if (question) sources.push(question);
  for (const source of sources) {
    for (const n of digitRuns(source)) {
      allowed.add(n);
      // "2025-09-06" yields "06"; a model writing "September 6" is reading it.
      const stripped = n.replace(/^0+(?=\d)/, "");
      if (stripped !== n) allowed.add(stripped);
    }
  }
  return allowed;
}

export function digitRuns(text: string): string[] {
  const normalized = text
    .replace(/\$/g, "")
    .replace(/(\d),(?=\d{3}(?!\d))/g, "$1")
    .replace(/(\d)\.00(?!\d)/g, "$1");
  return normalized.match(/\d+/g) ?? [];
}

export type NumberCheck = { ok: true } | { ok: false; reason: string };

export function checkNumbers(text: string, allowed: Set<string>): NumberCheck {
  for (const n of digitRuns(text)) {
    if (!allowed.has(n)) {
      const where = text.split(/(?<=[.!?])\s+/).find((s) => digitRuns(s).includes(n)) ?? text;
      return {
        ok: false,
        reason: `the number ${n} does not appear in any tool result: "${where.length > 120 ? `${where.slice(0, 117)}...` : where}"`,
      };
    }
  }
  return { ok: true };
}

/** Steps 2 to 4: citations, numbers, and the deterministic fallback. */
export function finalizeAnswer(
  modelText: string,
  results: AssistantToolResult[],
  question?: string,
): FinalAnswer {
  const bundle = toolResultsToBundle(results);
  const citationCheck = validateDefense(modelText, bundle);
  if (!citationCheck.ok) {
    return { content: buildFallbackAnswer(results), source: "fallback", reason: citationCheck.reason, citations: bundle.citations };
  }
  const numberCheck = checkNumbers(modelText, numberAllowlist(results, question));
  if (!numberCheck.ok) {
    return { content: buildFallbackAnswer(results), source: "fallback", reason: numberCheck.reason, citations: bundle.citations };
  }
  return { content: keepOnlyCitedRows(modelText, bundle), source: "model", citations: bundle.citations };
}

// ---------- the deterministic answer ----------

/**
 * One sentence per tool result, built from its rows and citing them, in the
 * style of buildFallbackDefense: the evidence first, never an apology. The
 * rows themselves render as a table beneath it.
 */
export function buildFallbackAnswer(results: AssistantToolResult[]): string {
  if (results.length === 0) {
    return "Nothing in the books or the runs was read for this question. Ask about a run, a sample, a counterparty, or the gaps waiting on you.";
  }
  return results.map(ledeFor).filter(Boolean).join(" ");
}

function cite(c: Citation | undefined): string {
  return c ? ` [${c.table}#${c.id}]` : "";
}

function field(row: Record<string, unknown> | undefined, key: string): string {
  const v = row?.[key];
  return v === undefined || v === null ? "" : String(v);
}

export function ledeFor(r: AssistantToolResult): string {
  if (r.error) return `${toolLabel(r.name)} could not be read: ${r.error}`;
  const first = r.rows[0];
  const c0 = r.citations[0];
  const note = r.note ? ` ${r.note}` : "";
  switch (r.name) {
    case "run_summary":
      if (!first) return `No run to summarise.${note}`;
      return (
        `Run ${field(first, "run")}${field(first, "name") ? ` (${field(first, "name")})` : ""} drew ${field(first, "samples")} samples: ${field(first, "defended")} defended, ${field(first, "gapsUnruled")} ${field(first, "gapsUnruled") === "1" ? "gap" : "gaps"} waiting on you, ${field(first, "exceptions")} ${field(first, "exceptions") === "1" ? "exception" : "exceptions"}` +
        (Number(field(first, "open")) > 0 ? `, ${field(first, "open")} open` : "") +
        `, coverage ${field(first, "coveragePercent")}%` +
        (Number(field(first, "resolvedByMemory")) > 0 ? `, ${field(first, "resolvedByMemory")} resolved by memory` : "") +
        `${cite(c0)}.${note}`
      );
    case "list_gaps":
      if (r.rows.length === 0) return `No gaps matched.${note}`;
      return (
        `${r.rows.length} ${r.rows.length === 1 ? "gap" : "gaps"} in run ${r.resolvedRunId ?? ""}: ` +
        r.rows
          .slice(0, 5)
          .map((row, i) => `${field(row, "label")} ${field(row, "amount")}, ${field(row, "gapKind").replace(/_/g, " ")}${cite(r.citations[i])}`)
          .join("; ") +
        `.${note}`
      );
    case "explain_sample":
      if (!first) return `No such sample.${note}`;
      return (
        `${field(first, "label")} for ${field(first, "amount")} on ${field(first, "date")} is ${field(first, "status")}${cite(c0)}` +
        (field(first, "gapKind") ? `; the accountant admitted ${field(first, "gapKind").replace(/_/g, " ")}: ${field(first, "gapDescription").replace(/[.\s]+$/, "")}${cite(c0)}.` : ".") +
        (field(first, "ruling") ? ` The controller ruled ${field(first, "ruling").toLowerCase()}${field(first, "rulingNote") ? `: "${field(first, "rulingNote")}"` : ""}${cite(r.citations.find((c) => c.table === "referee_decisions") ?? c0)}.` : "") +
        note
      );
    case "exposure_by_counterparty":
      if (r.rows.length === 0) return `No exposure found.${note}`;
      return (
        `Exposure in run ${r.resolvedRunId ?? ""} by counterparty: ` +
        r.rows
          .slice(0, 5)
          .map((row) => {
            const ids = field(row, "sampleIds").split(", ");
            const first = r.citations.find((c) => ids.some((id) => `${c.table}#${c.id}` === citationKeyOf(id)));
            return `${field(row, "counterparty")} ${field(row, "totalAmount")} across ${field(row, "gapCount")} ${field(row, "gapCount") === "1" ? "sample" : "samples"}${cite(first ?? c0)}`;
          })
          .join("; ") +
        `.${note}`
      );
    case "prior_rulings":
      if (r.rows.length === 0) return `No prior rulings.${note}`;
      return (
        `${r.rows.length} ${r.rows.length === 1 ? "ruling" : "rulings"} on file: ` +
        r.rows
          .slice(0, 5)
          .map((row) => `${field(row, "verdict").replace(/_/g, " ")} on ${field(row, "sample")} in run ${field(row, "run")}${field(row, "note") ? ` ("${field(row, "note")}")` : ""} [${field(row, "source")}]`)
          .join("; ") +
        `.${note}`
      );
    case "compare_runs": {
      const prev = r.rows.find((row) => row.side === "previous");
      const latest = r.rows.find((row) => row.side === "latest");
      if (!prev || !latest) return `${first ? `Run ${field(first, "run")} covered ${field(first, "coveragePercent")}%${cite(c0)}.` : ""}${note}`.trim();
      const recurring = r.rows.filter((row) => row.side === "recurring");
      return (
        `Run ${field(prev, "run")} covered ${field(prev, "coveragePercent")}% (${field(prev, "defended")} of ${field(prev, "samples")})${cite(r.citations[0])}; run ${field(latest, "run")} covered ${field(latest, "coveragePercent")}% (${field(latest, "defended")} of ${field(latest, "samples")}, ${field(latest, "resolvedByMemory")} by memory)${cite(r.citations[1])}.` +
        (recurring.length ? ` ${recurring.length} ${recurring.length === 1 ? "item" : "items"} recurred from the earlier run.` : "") +
        note
      );
    }
    case "where_is":
      if (!first) return `Nothing matched.${note}`;
      return `${field(first, "label")}: ${field(first, "href")}${cite(c0)}.${note}`;
    case "draft_note":
      if (!first) return `No draft.${note}`;
      return `Draft for ${field(first, "verdict").replace(/_/g, " ")} on ${field(first, "sample")}${cite(c0)}: ${field(first, "draft")}${note}`;
    case "propose_remedy":
      if (!first) return `No remedy.${note}`;
      return `Proposed remedy for ${field(first, "sample")}${cite(c0)}: ${field(first, "remedy").toLowerCase()}, with the entry Dr ${field(first, "debit")} / Cr ${field(first, "credit")} ${field(first, "amount")}${cite(c0)}.${note}`;
    case "start_run":
      if (!first) return `No run proposed.${note}`;
      if (field(first, "run")) return `Run ${field(first, "run")} started with ${field(first, "sampleCount")} samples${cite(c0)}.${note}`;
      return `Proposed run: seed ${field(first, "seed")}, materiality ${field(first, "materiality")}, ${field(first, "sampleSize")} samples, cycles ${field(first, "cycles")}.${note}`;
  }
}

function citationKeyOf(sampleId: string): string {
  const [prefix, id] = sampleId.split(":");
  const table = prefix === "invoice" ? "invoices" : prefix === "bank" ? "bank_transactions" : "dodo_transactions";
  return `${table}#${id}`;
}

export function toolLabel(name: string): string {
  return name.replace(/_/g, " ");
}

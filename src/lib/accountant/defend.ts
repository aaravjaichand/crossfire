/**
 * The one LLM call per sample. Everything the model is allowed to say is
 * already in the bundle: it turns citations and gaps into a paragraph and is
 * told to admit a gap rather than argue around it.
 */
import { complete } from "../llm";
import { formatSampleId } from "./sample";
import type { EvidenceBundle } from "./types";

const SYSTEM = [
  "You are the Accountant at Northwind Labs, Inc. answering an auditor's request for evidence on one sampled transaction.",
  "Write 3 to 5 sentences of plain prose. No headings, no bullet lists, no markdown.",
  "Use ONLY the numbered evidence and gaps given to you. Never invent a document, amount, date, name, or row id.",
  "Reference every factual claim with the row it came from in square brackets, like [invoices#15] or [bank_transactions#72].",
  "Brackets may only ever contain a table name and a row id from the evidence. Never bracket a gap, a rule, or a list item.",
  "If the evidence has gaps, say plainly and immediately that the item is not fully supported, name what is missing, and do not argue around it.",
  "If there are no gaps, state that the item ties out and show the chain: document, payment, ledger.",
].join(" ");

export function buildDefensePrompt(bundle: EvidenceBundle): string {
  const citations = bundle.citations.length
    ? bundle.citations
        .map(
          (c, i) =>
            `${i + 1}. [${c.table}#${c.id}] ${c.field} = ${c.value}` +
            (c.filePath ? ` (file: ${c.filePath})` : "") +
            ` — ${c.reason}`,
        )
        .join("\n")
    : "(none found)";
  const gaps = bundle.gaps.length
    ? bundle.gaps.map((g, i) => `${i + 1}. ${g.kind}: ${g.description}`).join("\n")
    : "(none)";

  return [
    `Sample under audit: ${formatSampleId(bundle.sample)}`,
    "",
    "Evidence gathered from the books:",
    citations,
    "",
    "Gaps found by the reconciliation checks:",
    gaps,
    "",
    bundle.gaps.length
      ? "Write the accountant's response. Concede the gaps above."
      : "Write the accountant's response defending this transaction.",
  ].join("\n");
}

/** Adds bundle.defense using exactly one LLM call. Leaves the bundle otherwise untouched. */
export async function writeDefense(bundle: EvidenceBundle): Promise<EvidenceBundle> {
  const defense = await complete(SYSTEM, buildDefensePrompt(bundle));
  return { ...bundle, defense: keepOnlyCitedRows(defense, bundle) };
}

/**
 * glm-4-7-flash sometimes writes "[gaps#1]" or "[gap: rate_mismatch]" next to
 * the real row references. Only a bracket naming a row that is actually in the
 * bundle is a citation; anything else is removed rather than shown to the
 * referee as if it were evidence.
 */
export function keepOnlyCitedRows(text: string, bundle: EvidenceBundle): string {
  const cited = new Set(bundle.citations.map((c) => `${c.table}#${c.id}`));
  return text
    .replace(/\[[^\]]*\]/g, (match) => {
      const parts = match
        .slice(1, -1)
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length === 0) return "";
      // "[ledger_entries#225, #226]" repeats the table implicitly.
      let table: string | undefined;
      for (const part of parts) {
        const m = part.match(/^([a-z_]+)?#(\d+)$/);
        if (!m) return "";
        table = m[1] ?? table;
        if (!table || !cited.has(`${table}#${m[2]}`)) return "";
      }
      return match;
    })
    .replace(/[ \t]+([.,;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

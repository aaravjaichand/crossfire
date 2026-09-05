/**
 * The one LLM call per sample. Everything the model is allowed to say is
 * already in the bundle: it turns citations and gaps into a paragraph and is
 * told to admit a gap rather than argue around it.
 */
import { complete } from "../llm";
import { finalizeDefense } from "./citations";
import { formatSampleId } from "./sample";
import type { EvidenceBundle } from "./types";

export const DEFENSE_SYSTEM_PROMPT = [
  "You are the Accountant at Northwind Labs, Inc. answering an auditor's request for evidence on one sampled transaction.",
  "Write 3 to 5 sentences of plain prose. No headings, no bullet lists, no markdown.",
  "Use ONLY the numbered evidence and gaps given to you. Never invent a document, amount, date, name, or row id.",
  "Every sentence that states an amount, a date, a name or any other specific fact must contain at least one row reference in square brackets, like [invoices#15] or [bank_transactions#72]. This includes the sentence that concedes a gap: cite the row the gap was found on.",
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

/**
 * Adds bundle.defense using exactly one LLM call. The model's paragraph only
 * survives if it satisfies the citation invariant; otherwise the deterministic
 * fallback is used, still without a second request.
 */
export async function writeDefense(bundle: EvidenceBundle): Promise<EvidenceBundle> {
  const modelText = await complete(DEFENSE_SYSTEM_PROMPT, buildDefensePrompt(bundle));
  const final = finalizeDefense(modelText, bundle);
  return { ...bundle, defense: final.defense };
}

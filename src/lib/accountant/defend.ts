/**
 * The one LLM call per sample. Everything the model is allowed to say is
 * already in the bundle: it turns citations and gaps into a paragraph and is
 * told to admit a gap rather than argue around it.
 */
import { complete } from "../llm";
import { buildFallbackDefense, finalizeDefense } from "./citations";
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

export type DefendOptions = {
  /**
   * Auditor follow-ups this answer must address, oldest first. The accountant
   * searches the same books either way — gatherEvidence is deterministic — so
   * a follow-up widens what the answer has to speak to, not what it may cite.
   */
  followUps?: readonly string[];
};

/** Set CROSSFIRE_NO_LLM=1 to run the whole product on deterministic prose. */
export function llmDisabled(): boolean {
  return process.env.CROSSFIRE_NO_LLM === "1";
}

/**
 * Test-only fault injection: CROSSFIRE_LLM_FAIL=1 makes every model call throw
 * before it is made, so a check suite can exercise the "the model errored"
 * branch offline, deterministically, and without waiting on a real timeout.
 * Mirrors persist.ts's failAfterSampleCount. Never set it outside a check.
 */
export function llmForcedToFail(): boolean {
  return process.env.CROSSFIRE_LLM_FAIL === "1";
}

export function buildDefensePrompt(bundle: EvidenceBundle, options: DefendOptions = {}): string {
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

  const followUps = options.followUps ?? [];
  const pushBack = followUps.length
    ? [
        "",
        "The auditor was not satisfied and pushed back. Answer these directly, in order:",
        followUps.map((f, i) => `${i + 1}. ${f}`).join("\n"),
        "",
        "The evidence above is the result of searching the books again. If a row the auditor",
        "asked for is not in that list, it does not exist: say so plainly and do not promise to look further.",
      ]
    : [];

  return [
    `Sample under audit: ${formatSampleId(bundle.sample)}`,
    "",
    "Evidence gathered from the books:",
    citations,
    "",
    "Gaps found by the reconciliation checks:",
    gaps,
    ...pushBack,
    "",
    bundle.gaps.length
      ? "Write the accountant's response. Concede the gaps above."
      : "Write the accountant's response defending this transaction.",
  ].join("\n");
}

/**
 * Adds bundle.defense using at most one LLM call. The model's paragraph only
 * survives if it satisfies the citation invariant; otherwise the deterministic
 * fallback is used, still without a second request. A model error (or
 * CROSSFIRE_NO_LLM=1) falls back the same way rather than throwing, so a run
 * never fails on the model.
 */
export async function writeDefense(
  bundle: EvidenceBundle,
  options: DefendOptions = {},
): Promise<EvidenceBundle> {
  const fallback = (reason: string): EvidenceBundle => ({
    ...bundle,
    defense: buildFallbackDefense(bundle, { followUps: options.followUps }),
    defenseSource: { source: "fallback", reason },
  });

  if (llmDisabled()) {
    return fallback("the model was turned off for this run (CROSSFIRE_NO_LLM)");
  }

  let modelText: string;
  try {
    if (llmForcedToFail()) {
      throw new Error("[defend probe] simulated model failure (CROSSFIRE_LLM_FAIL)");
    }
    modelText = await complete(DEFENSE_SYSTEM_PROMPT, buildDefensePrompt(bundle, options));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[accountant/defend] LLM call failed, falling back to the gathered rows: ${message}`);
    return fallback(`the model call failed: ${message}`);
  }

  const final = finalizeDefense(modelText, bundle);
  return {
    ...bundle,
    defense: final.defense,
    defenseSource: { source: final.source, ...(final.reason ? { reason: final.reason } : {}) },
  };
}

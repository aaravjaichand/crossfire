/**
 * The citation invariant from CLAUDE.md, enforced deterministically after the
 * model has spoken: "Every agent claim must cite a document and row id. No
 * uncited assertions."
 *
 * Three rules, applied to the model's paragraph:
 *   1. A bracket is a citation only if it names a table#id that is actually in
 *      this bundle. Anything else ("[gaps#1]", "[gap: rate_mismatch]",
 *      "[invoices#999]") is not evidence.
 *   2. Every factual sentence must carry at least one valid citation. A
 *      sentence is factual when it states something specific about the books:
 *      an amount, a date, a multi-digit number, a row reference, or a value
 *      that appears in the bundle's citations (a vendor, an approver, an
 *      invoice number). A sentence that reached for a citation and got it wrong
 *      counts as factual too, so prose leaning on invented rows cannot survive
 *      by having its brackets quietly removed. Connective or concessive prose
 *      that asserts no specific fact does not need a citation.
 *   3. The paragraph must carry at least one valid citation overall.
 *
 * If any rule fails the model's paragraph is discarded and replaced by a
 * paragraph assembled from the bundle itself. There is no second request: the
 * fallback is pure string work over rows that are already in hand.
 */
import { formatSampleId } from "./sample";
import type { EvidenceBundle } from "./types";

export type DefenseCheck = { ok: true } | { ok: false; reason: string };

export type FinalDefense = {
  defense: string;
  source: "model" | "fallback";
  /** Why the model's paragraph was rejected, when it was. */
  reason?: string;
};

/**
 * Rule 1 as a rewrite: only a bracket naming a row in the bundle is kept, so
 * nothing that merely looks like a citation reaches the referee. Run this after
 * validateDefense, which needs to see what the model originally claimed.
 */
export function keepOnlyCitedRows(text: string, bundle: EvidenceBundle): string {
  const cited = citedRows(bundle);
  return text
    .replace(/\[[^\]]*\]/g, (match) => (bracketRows(match, cited) ? match : ""))
    .replace(/,(\s*,)+/g, ",")
    .replace(/[ \t]+([.,;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Rules 2 and 3, against the model's original text. */
export function validateDefense(text: string, bundle: EvidenceBundle): DefenseCheck {
  const cited = citedRows(bundle);
  if (!text.trim()) return { ok: false, reason: "the model returned nothing" };

  let validCitations = 0;
  for (const sentence of splitSentences(text)) {
    const brackets = sentence.match(/\[[^\]]*\]/g) ?? [];
    const valid = brackets.filter((b) => bracketRows(b, cited));
    validCitations += valid.length;
    if (valid.length > 0) continue;

    if (brackets.length > 0) {
      return {
        ok: false,
        reason: `a sentence whose only citations are not rows in this bundle: "${truncate(sentence)}"`,
      };
    }
    if (isFactualSentence(sentence, bundle)) {
      return { ok: false, reason: `an uncited factual sentence: "${truncate(sentence)}"` };
    }
  }

  if (cited.size > 0 && validCitations === 0) {
    return { ok: false, reason: "the paragraph cites no row from the bundle" };
  }
  return { ok: true };
}

/** Applies all three rules and falls back deterministically when they fail. */
export function finalizeDefense(modelText: string, bundle: EvidenceBundle): FinalDefense {
  const check = validateDefense(modelText, bundle);
  if (!check.ok) {
    return { defense: buildFallbackDefense(bundle), source: "fallback", reason: check.reason };
  }
  return { defense: keepOnlyCitedRows(modelText, bundle), source: "model" };
}

/**
 * The deterministic defense: every sentence is built from rows already in the
 * bundle, so it satisfies the invariant by construction. No model call.
 */
export function buildFallbackDefense(bundle: EvidenceBundle): string {
  const sampleId = formatSampleId(bundle.sample);
  const [primary, ...rest] = bundle.citations;
  if (!primary) {
    return `No evidence rows were gathered for sample ${sampleId}, so there is nothing to support it.`;
  }

  const anchor = `[${primary.table}#${primary.id}]`;
  const sentences = [
    "This response is assembled from the gathered rows rather than written by the model, because the drafted wording did not cite the evidence it relied on.",
    `Sample ${sampleId} rests on ${describe(primary)}.`,
  ];

  const supporting = rest.slice(0, 4);
  if (supporting.length > 0) {
    sentences.push(`It is supported by ${supporting.map(describe).join("; ")}.`);
  }
  if (rest.length > supporting.length) {
    sentences.push(
      `A further ${rest.length - supporting.length} rows gathered for ${anchor} are listed with this bundle.`,
    );
  }
  if (bundle.gaps.length === 0) {
    sentences.push(`No reconciliation check on ${anchor} found a gap.`);
  } else {
    for (const gap of bundle.gaps) {
      sentences.push(`Gap ${gap.kind} on ${anchor}: ${gap.description}`);
    }
  }
  return sentences.join(" ");
}

// ---------- internals ----------

function citedRows(bundle: EvidenceBundle): Set<string> {
  return new Set(bundle.citations.map((c) => `${c.table}#${c.id}`));
}

/** True when every part of a bracket names a row in the bundle. */
function bracketRows(bracket: string, cited: Set<string>): boolean {
  const parts = bracket
    .slice(1, -1)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;
  // "[ledger_entries#225, #226]" repeats the table implicitly.
  let table: string | undefined;
  for (const part of parts) {
    const m = part.match(/^([a-z_]+)?#(\d+)$/);
    if (!m) return false;
    table = m[1] ?? table;
    if (!table || !cited.has(`${table}#${m[2]}`)) return false;
  }
  return true;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=["([]?[A-Z0-9$])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const MONEY = /\$\s?\d/;
const ISO_DATE = /\d{4}-\d{2}-\d{2}/;
const ROW_REFERENCE = /#\d+/;
const MULTI_DIGIT = /\b\d{2,}\b/;

export function isFactualSentence(sentence: string, bundle: EvidenceBundle): boolean {
  if (
    MONEY.test(sentence) ||
    ISO_DATE.test(sentence) ||
    ROW_REFERENCE.test(sentence) ||
    MULTI_DIGIT.test(sentence)
  ) {
    return true;
  }
  const haystack = sentence.toLowerCase();
  for (const citation of bundle.citations) {
    if (haystack.includes(citation.table)) return true;
    const value = citation.value.trim().toLowerCase();
    if (value.length >= 4 && value !== "null" && haystack.includes(value)) return true;
  }
  return false;
}

function describe(citation: EvidenceBundle["citations"][number]): string {
  return `[${citation.table}#${citation.id}] ${citation.field} = ${citation.value}`;
}

function truncate(text: string, max = 120): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

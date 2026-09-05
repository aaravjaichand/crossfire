// Guarantees every stored opening question carries a citation to the exact
// row being sampled, in the same "[table#id]" format the accountant module
// uses (src/lib/accountant/citations.ts). This is applied in code after the
// LLM has phrased the question — never left for the model to add, so a
// rephrasing that drops or mangles the identifier can't slip through.
import type { SampleType } from "./evidence-types";

export const TABLE_BY_SAMPLE_TYPE: Record<SampleType, string> = {
  bank_transaction: "bank_transactions",
  invoice: "invoices",
  dodo_transaction: "dodo_transactions",
};

export type CitableSample = { sampleType: SampleType; sampleId: number };

/** "[bank_transactions#20]" for the sampled row. */
export function sampleCitation(sample: CitableSample): string {
  return `[${TABLE_BY_SAMPLE_TYPE[sample.sampleType]}#${sample.sampleId}]`;
}

/**
 * Appends the sample's citation to `text` if it isn't already present
 * verbatim. Deterministic and idempotent: calling it twice on its own output
 * is a no-op.
 */
export function withSampleCitation(text: string, sample: CitableSample): string {
  const citation = sampleCitation(sample);
  const trimmed = text.trim();
  if (trimmed.includes(citation)) return trimmed;
  if (trimmed.length === 0) return `${citation}.`;
  return /[.?!]$/.test(trimmed) ? `${trimmed} ${citation}` : `${trimmed} ${citation}.`;
}

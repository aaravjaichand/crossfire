export type SampleType = "bank_transaction" | "invoice" | "dodo_transaction";

export type SampleRef = { type: SampleType; id: number };

export type Citation = {
  table: string;   // e.g. "invoices", "contracts", "bank_transactions", "ledger_entries", "dodo_transactions", "vendors"
  id: number;      // row id in that table
  field: string;   // column name cited, e.g. "amount", "monthly_rate", "approved_by"
  value: string;   // the value as a string
  reason: string;  // one sentence: why this row supports the defense
  filePath?: string; // set when the row has a file_path (invoice or contract PDF)
};

export type GapKind =
  | "no_matching_invoice"
  | "rate_mismatch"
  | "duplicate_payment"
  | "missing_approval"
  | "missing_ledger_entry"
  | "no_bank_match"
  | "unknown_counterparty"
  | "outside_contract_term"
  | "duplicate_invoice_month"
  | "payout_mismatch"
  | "other";

export type Gap = { kind: GapKind; description: string };

/**
 * Where the defense prose came from. Kept beside the prose rather than inside
 * it: the fact that a paragraph was assembled from rows instead of written by
 * the model is provenance, not something the accountant should say out loud in
 * front of a reader. The UI can render it as a small label.
 */
export type DefenseSource = {
  source: "model" | "fallback";
  /** Why the fallback was used. Absent when source is "model". */
  reason?: string;
};

export type EvidenceBundle = {
  sample: SampleRef;
  citations: Citation[];
  gaps: Gap[];
  defense?: string; // LLM-written paragraph, present only after the LLM step
  /**
   * Provenance for `defense`. Additive on purpose: the referee module rebuilds
   * bundles field by field and reads `defense` as a string, so this could not
   * be nested inside it without breaking that parser.
   */
  defenseSource?: DefenseSource;
};

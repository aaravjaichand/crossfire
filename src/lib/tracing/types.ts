/**
 * The shape Neatlogs' HTTP ingest accepts: one nested tree per POST.
 *
 * Neatlogs generates trace_id, span_id, and parent_span_id from the shape of
 * the tree itself, so nothing here carries an id. That is also why a trace is
 * buffered until the run finishes rather than streamed: the whole tree goes in
 * one request or not at all.
 *
 * See https://docs.neatlogs.com/sdk/http-injection.
 */

export type SpanKind = "WORKFLOW" | "AGENT" | "LLM" | "TOOL";

export type SpanNode = {
  name: string;
  kind: SpanKind;
  /** Required on the root when posting with a write key. */
  project?: string;
  model?: string;
  input?: string;
  output?: string;
  tokens?: { prompt?: number; completion?: number; total?: number };
  status?: "OK" | "ERROR";
  error?: string;
  /** ISO timestamps. */
  start?: string;
  end?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
  children?: SpanNode[];
};

/** What one LLM call contributes to the tree. */
export type LlmCall = {
  /** "accountant.defense" or "auditor.question". */
  name: string;
  model: string;
  input: string;
  output?: string;
  error?: string;
  tokens?: { prompt?: number; completion?: number; total?: number };
  metadata?: Record<string, unknown>;
  startedAt: number;
  endedAt: number;
};

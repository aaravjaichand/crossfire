/**
 * The Neatlogs client: one POST, no dependency, and no way to fail loudly.
 *
 * The published TypeScript SDK auto-instruments the OpenAI client at import
 * time, which would put a package between the run and the model on a deadline
 * and inside a serverless function. The documented HTTP ingest does the same
 * job in thirty lines: POST the finished tree to /v1/trace with the write key.
 *
 * Two rules this file exists to enforce:
 *
 *   - It never throws. Every caller is on the run's critical path, and an
 *     observability failure must never be the reason an audit run fails.
 *   - It never blocks for long. The request is aborted after TIMEOUT_MS, so a
 *     hung ingest endpoint costs one bounded pause at the end of a run.
 */
import type { SpanNode } from "./types";

export const DEFAULT_ENDPOINT = "https://ingest.neatlogs.com/v1/trace";
export const PROJECT = "crossfire";
export const TIMEOUT_MS = 2_000;

/** Longest input/output text kept on a span. A defense prompt embeds the whole
 * evidence bundle; 25 samples of that unbounded is a multi-megabyte POST. */
export const MAX_TEXT = 2_000;

export type PostResult =
  | { ok: true; spans: number }
  | { ok: false; reason: string };

export type PostOptions = {
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
  /** Injected by the checks so they can exercise this without a network. */
  fetchImpl?: typeof fetch;
};

/** True when a key is configured and tracing has not been turned off. */
export function tracingEnabled(): boolean {
  if (process.env.CROSSFIRE_NO_TRACING === "1") return false;
  return Boolean(process.env.NEATLOGS_API_KEY);
}

export function clip(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}

/**
 * Posts one finished trace tree. Resolves either way; the boolean is for the
 * checks and the debug log, never for control flow in the run.
 */
export async function postTrace(root: SpanNode, options: PostOptions = {}): Promise<PostResult> {
  const apiKey = options.apiKey ?? process.env.NEATLOGS_API_KEY;
  if (!apiKey) return { ok: false, reason: "NEATLOGS_API_KEY is not set" };

  const endpoint = options.endpoint ?? process.env.NEATLOGS_ENDPOINT ?? DEFAULT_ENDPOINT;
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);

  try {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ project: PROJECT, ...root }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: `ingest returned ${response.status}` };
    const body = (await response.json().catch(() => ({}))) as { spans?: number };
    return { ok: true, spans: typeof body.spans === "number" ? body.spans : countSpans(root) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function countSpans(node: SpanNode): number {
  return 1 + (node.children ?? []).reduce((n, child) => n + countSpans(child), 0);
}

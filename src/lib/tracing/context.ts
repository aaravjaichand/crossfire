/**
 * Where a span belongs, without every function having to be told.
 *
 * The shape Neatlogs shows is one trace per run and one span per sample:
 *
 *   audit run 12                (WORKFLOW)
 *     └ sample invoice:15       (AGENT)
 *         ├ auditor.question    (LLM)
 *         └ accountant.defense  (LLM)
 *
 * The two model calls are made deep inside the accountant and the auditor,
 * which know their sample at best and never know their run. Passing a tracer
 * down through defend() and phraseQuestion() would put an observability
 * argument in the middle of two agent APIs, so the run and the sample are held
 * in an AsyncLocalStorage instead and the call sites only say what they did.
 *
 * Every entry point here is a no-op when NEATLOGS_API_KEY is unset, and none
 * of them can throw: withRunTrace and withSampleSpan return exactly what the
 * wrapped function returns, and rethrow exactly what it threw.
 *
 * An LLM call made with no run on the stack (a check script, a one-off
 * `pnpm accountant`) is not dropped: it goes to a buffer that is posted as its
 * own small trace when the buffer fills or the process is about to exit.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { clip, postTrace, tracingEnabled, type PostOptions } from "./neatlogs";
import type { LlmCall, SpanNode } from "./types";

type Context = { root: SpanNode; sample?: SpanNode };

const storage = new AsyncLocalStorage<Context>();

/** LLM calls made outside any run, waiting for a trace to belong to. */
const orphans: SpanNode[] = [];
const ORPHAN_LIMIT = 16;

let exitHookInstalled = false;

export type RunMeta = {
  runId: number | string;
  name?: string;
  metadata?: Record<string, unknown>;
};

export type SampleMeta = {
  /** invoice | bank_transaction | dodo_transaction */
  type: string;
  /** The row id in that table. */
  id: number;
  /** audit_samples.id, when the caller has it. */
  auditSampleId?: number;
  metadata?: Record<string, unknown>;
};

/** One trace per run. Flushed once, in a finally, before the run returns. */
export async function withRunTrace<T>(meta: RunMeta, fn: () => Promise<T>): Promise<T> {
  if (!tracingEnabled()) return fn();

  const root: SpanNode = {
    name: meta.name ?? `audit run ${meta.runId}`,
    kind: "WORKFLOW",
    start: new Date().toISOString(),
    metadata: { runId: String(meta.runId), ...meta.metadata },
    children: [],
  };

  try {
    return await storage.run({ root }, fn);
  } catch (err) {
    root.status = "ERROR";
    root.error = message(err);
    throw err;
  } finally {
    close(root);
    // Awaited on purpose: `pnpm auditor:run` exits the moment runAudit()
    // returns, and a fire-and-forget POST would never leave the process.
    // postTrace is bounded by its own timeout, so this costs 2s at worst.
    await postTrace(root);
  }
}

/** One span per sample, hung off the run trace. Outside a run, a plain call. */
export async function withSampleSpan<T>(meta: SampleMeta, fn: () => Promise<T>): Promise<T> {
  const context = storage.getStore();
  if (!tracingEnabled() || !context) return fn();

  const span: SpanNode = {
    name: `sample ${meta.type}:${meta.id}`,
    kind: "AGENT",
    start: new Date().toISOString(),
    metadata: {
      sampleType: meta.type,
      sampleId: meta.id,
      ...(meta.auditSampleId === undefined ? {} : { auditSampleId: meta.auditSampleId }),
      ...meta.metadata,
    },
    children: [],
  };
  context.root.children!.push(span);

  try {
    return await storage.run({ root: context.root, sample: span }, fn);
  } catch (err) {
    span.status = "ERROR";
    span.error = message(err);
    throw err;
  } finally {
    close(span);
  }
}

/**
 * Times one model call and files the span under whatever is on the stack. The
 * function's result and its errors pass straight through: the two call sites
 * already decide what a model failure means, and tracing does not get a vote.
 */
export async function traceLlmCall<T>(
  meta: { name: string; model: string; input: string; metadata?: Record<string, unknown> },
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracingEnabled()) return fn();
  const startedAt = Date.now();
  try {
    const result = await fn();
    recordLlmCall({
      ...meta,
      output: typeof result === "string" ? result : undefined,
      startedAt,
      endedAt: Date.now(),
    });
    return result;
  } catch (err) {
    recordLlmCall({ ...meta, error: message(err), startedAt, endedAt: Date.now() });
    throw err;
  }
}

export function recordLlmCall(call: LlmCall): void {
  if (!tracingEnabled()) return;
  const span = llmSpan(call);
  const context = storage.getStore();
  const parent = context?.sample ?? context?.root;
  if (parent) {
    parent.children!.push(span);
    return;
  }
  orphans.push(span);
  installExitHook();
  if (orphans.length >= ORPHAN_LIMIT) void flushOrphans();
}

/**
 * Posts the buffered contextless calls as one small trace. Safe to call at any
 * time and safe to call twice: the buffer is emptied before the request goes
 * out, so a second call with nothing left in it does nothing.
 */
export async function flushOrphans(options: PostOptions = {}): Promise<void> {
  if (orphans.length === 0) return;
  const children = orphans.splice(0, orphans.length);
  const root: SpanNode = {
    name: "crossfire model calls",
    kind: "WORKFLOW",
    start: children[0]?.start,
    end: new Date().toISOString(),
    metadata: { context: "no audit run on the stack" },
    children,
  };
  await postTrace(root, options);
}

/** Test seam: the checks build a tree without a network or a run. */
export function currentSpanTree(): SpanNode | undefined {
  return storage.getStore()?.root;
}

function llmSpan(call: LlmCall): SpanNode {
  return {
    name: call.name,
    kind: "LLM",
    model: call.model,
    input: clip(call.input),
    output: call.output === undefined ? undefined : clip(call.output),
    tokens: call.tokens,
    status: call.error ? "ERROR" : "OK",
    error: call.error,
    start: new Date(call.startedAt).toISOString(),
    end: new Date(call.endedAt).toISOString(),
    duration_ms: call.endedAt - call.startedAt,
    metadata: call.metadata,
  };
}

function close(span: SpanNode): void {
  span.end = new Date().toISOString();
  if (span.start) span.duration_ms = Date.parse(span.end) - Date.parse(span.start);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  if (typeof process === "undefined" || typeof process.on !== "function") return;
  exitHookInstalled = true;
  // beforeExit runs while the loop is still alive, so the in-flight POST keeps
  // the process up long enough to land. A hard process.exit() skips it, which
  // is the right trade: nothing waits on a trace.
  process.on("beforeExit", () => {
    void flushOrphans();
  });
}

/**
 * One assistant turn: the question goes to the model with the ten tool
 * schemas, the tools it asks for run, and the paragraph it writes is checked
 * against the rows before anything is persisted.
 *
 * Four deterministic stops guard against a runaway (the design's probe E):
 * at most MAX_CALLS_PER_ROUND calls per round, deduplicated on name + args;
 * at most MAX_ROUNDS rounds with tools, after which the tools are removed so
 * the model must answer from what it has; a TURN_BUDGET_MS wall clock on the
 * whole turn through one AbortSignal; and tool_choice "required" refused in
 * llm.ts.
 *
 * When the model cannot be used — turned off, no key, 4xx/5xx, timeout,
 * malformed tool calls — the turn still answers, one step down at a time:
 * the keyword router picks a tool (fallback 1), the model is asked only to
 * phrase the rows (fallback 2), and finally the rows render under a
 * deterministic lede with no model at all (fallback 3).
 */
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { llmDisabled, llmForcedToFail } from "@/lib/accountant/defend";
import type { DefenseSource } from "@/lib/accountant/types";
import { chat as modelChat, LLM_MODEL, type ChatOptions } from "@/lib/llm";
import { recordLlmCall, withRunTrace } from "@/lib/tracing";
import { buildFallbackAnswer, finalizeAnswer } from "./answer";
import { resolveRunArg } from "./handlers";
import { ASSISTANT_SYSTEM_PROMPT, PHRASE_SYSTEM_PROMPT } from "./prompt";
import { argsFor, route, type RouterContext } from "./router";
import { executeStartRun } from "./start-run";
import { appendMessage, createThread, getMessage, listMessages, updateDraft, CONTEXT_MESSAGES } from "./threads";
import { TOOL_BY_NAME, TOOL_SCHEMAS, runTool } from "./tools";
import {
  isToolName,
  type AssistantDraft,
  type AssistantMessageView,
  type AssistantToolCall,
  type AssistantToolResult,
  type ToolArgs,
  type ToolName,
} from "./types";

export const MAX_ROUNDS = 3;
export const MAX_CALLS_PER_ROUND = 4;
export const TURN_BUDGET_MS = 20_000;
/** Below this much budget left, no further model call is attempted. */
const MIN_MODEL_MS = 3_000;

export type ChatFn = (options: ChatOptions) => ReturnType<typeof modelChat>;

export type TurnInput = {
  threadId?: number;
  message: string;
  runId?: string;
  sampleRef?: string;
  forceTool?: ToolName;
};

export type TurnOutput = {
  threadId: number;
  message: AssistantMessageView;
  resolvedRunId: string;
};

export type TurnOptions = {
  /** Test seam: the check suite substitutes a stub model. */
  chat?: ChatFn;
  /** Test seam: treat the model as on even without a key. */
  forceModelOn?: boolean;
};

export type Answer = {
  content: string;
  toolCalls: AssistantToolCall[];
  toolResults: AssistantToolResult[];
  draft?: AssistantDraft;
  answerSource: DefenseSource;
  resolvedRunId: string;
  /** How many model calls were made. */
  modelCalls: number;
  /** Tool calls dropped by the cap or the deduplication. */
  dropped: number;
};

// ---------- the persisted turn ----------

export async function runAssistantTurn(input: TurnInput, options: TurnOptions = {}): Promise<TurnOutput> {
  const context: RouterContext = { runId: input.runId, sampleRef: input.sampleRef };
  const threadId = input.threadId ?? (await createThread(input.message, input.runId));
  const history = (await listMessages(threadId)).slice(-CONTEXT_MESSAGES);

  await appendMessage({
    threadId,
    role: "user",
    content: input.message,
    runId: input.runId,
    sampleRef: input.sampleRef,
  });

  const answer = await withRunTrace(
    { runId: `assistant:${threadId}`, name: `assistant thread ${threadId}`, metadata: { question: input.message } },
    () => answerQuestion(input.message, history, context, input.forceTool, options),
  );

  const draft = answer.draft;
  const message = await appendMessage({
    threadId,
    role: "assistant",
    content: answer.content,
    toolCalls: answer.toolCalls,
    toolResults: answer.toolResults,
    citations: answer.toolResults.flatMap((r) => r.citations),
    draft,
    runId: draft && draft.kind !== "start_run" ? draft.runId : answer.resolvedRunId,
    sampleRef: draft && draft.kind !== "start_run" ? draft.sampleRef : input.sampleRef,
    answerSource: answer.answerSource,
  });
  return { threadId, message, resolvedRunId: answer.resolvedRunId };
}

/**
 * The human clicked "Start run" on a proposal. The parameters are read back
 * off the persisted message, never off the request, and the run is created
 * exactly once: a second click finds startedRunId set and refuses.
 */
export async function confirmStartRun(threadId: number, messageId: number): Promise<TurnOutput | { error: string }> {
  const proposal = await getMessage(messageId);
  if (!proposal || proposal.threadId !== threadId) return { error: "That proposal is not in this thread." };
  const draft = proposal.draft;
  if (!draft || draft.kind !== "start_run") return { error: "That message carries no run to start." };
  if (draft.startedRunId) return { error: `Run ${draft.startedRunId} was already started from this proposal.` };

  const result = await executeStartRun(draft.params);
  const runId = String(result.rows[0]?.run ?? "");
  await updateDraft(messageId, {
    ...draft,
    startedRunId: Number(runId),
    startedSampleCount: Number(result.rows[0]?.sampleCount ?? 0),
  });

  const toolResult: AssistantToolResult = { name: "start_run", args: { ...draft.params, confirmed: true }, ...result };
  const message = await appendMessage({
    threadId,
    role: "assistant",
    content: buildFallbackAnswer([toolResult]),
    toolCalls: [{ name: "start_run", args: { ...draft.params, confirmed: true } }],
    toolResults: [toolResult],
    citations: result.citations,
    runId,
    answerSource: { source: "fallback", reason: "written by code: a started run is reported, not phrased" },
  });
  return { threadId, message, resolvedRunId: runId };
}

// ---------- the loop ----------

function modelAvailable(options: TurnOptions): boolean {
  // A substituted model is a check's, and runs whatever the environment says.
  if (options.chat) return true;
  if (llmDisabled()) return false;
  if (options.forceModelOn) return true;
  return Boolean(process.env.TENSORMUX_API_KEY);
}

export async function answerQuestion(
  question: string,
  history: AssistantMessageView[],
  context: RouterContext,
  forceTool: ToolName | undefined,
  options: TurnOptions = {},
): Promise<Answer> {
  const chat = options.chat ?? modelChat;
  const startedAt = Date.now();
  const deadline = startedAt + TURN_BUDGET_MS;
  const remaining = () => deadline - Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_BUDGET_MS);

  const toolCalls: AssistantToolCall[] = [];
  const results: ExecutedResult[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let modelCalls = 0;
  let modelText: string | undefined;
  let failure: string | undefined;
  let timedOut = false;

  const execute = async (name: ToolName, args: ToolArgs): Promise<ExecutedResult> => {
    const call: AssistantToolCall = { name, args };
    toolCalls.push(call);
    const result = await executeTool(call);
    results.push(result);
    return result;
  };

  const model = async (name: string, request: Omit<ChatOptions, "signal">) => {
    modelCalls += 1;
    const callStart = Date.now();
    const last = request.messages[request.messages.length - 1];
    const input = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    try {
      if (llmForcedToFail()) throw new Error("[assistant probe] simulated model failure (CROSSFIRE_LLM_FAIL)");
      const message = await chat({ ...request, signal: controller.signal });
      recordLlmCall({
        name,
        model: LLM_MODEL,
        input,
        output: message.tool_calls?.length ? JSON.stringify(message.tool_calls) : (message.content ?? ""),
        startedAt: callStart,
        endedAt: Date.now(),
        metadata: { finishReason: message.finish_reason },
      });
      return message;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      recordLlmCall({ name, model: LLM_MODEL, input, error: text, startedAt: callStart, endedAt: Date.now() });
      throw err;
    }
  };

  try {
    if (modelAvailable(options)) {
      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: ASSISTANT_SYSTEM_PROMPT + contextLine(context) },
        ...history
          .filter((m) => m.content.trim().length > 0)
          .map<ChatCompletionMessageParam>((m) =>
            m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content },
          ),
        { role: "user", content: question },
      ];

      let forceAnswer = false;
      for (let round = 1; round <= MAX_ROUNDS + 1; round++) {
        const withTools = round <= MAX_ROUNDS && !forceAnswer;
        if (remaining() < MIN_MODEL_MS) {
          failure = "the turn's time budget ran out";
          timedOut = true;
          break;
        }
        let reply: Awaited<ReturnType<ChatFn>>;
        try {
          reply = await model(`assistant.round${round}`, {
            messages,
            ...(withTools
              ? {
                  tools: TOOL_SCHEMAS,
                  toolChoice:
                    round === 1 && forceTool ? { type: "function", function: { name: forceTool } } : "auto",
                }
              : {}),
          });
        } catch (err) {
          failure = `the model call failed: ${err instanceof Error ? err.message : String(err)}`;
          timedOut = controller.signal.aborted;
          break;
        }

        const parsed = withTools ? parseToolCalls(reply.tool_calls) : { ok: true as const, calls: [] };
        if (!parsed.ok) {
          failure = parsed.reason;
          break;
        }
        if (parsed.calls.length === 0) {
          modelText = (reply.content ?? "").trim();
          break;
        }

        // Cap and deduplicate. A call repeated with the same arguments, in
        // this round or an earlier one, is dropped and the drop recorded.
        const kept: { id: string; name: ToolName; args: ToolArgs }[] = [];
        for (const c of parsed.calls) {
          const key = `${c.name}:${JSON.stringify(c.args)}`;
          if (seen.has(key) || kept.length >= MAX_CALLS_PER_ROUND) {
            dropped += 1;
            continue;
          }
          seen.add(key);
          kept.push(c);
        }
        if (kept.length === 0) {
          // Nothing new to run: the next call answers from what it has.
          forceAnswer = true;
          continue;
        }

        messages.push({
          role: "assistant",
          content: reply.content ?? "",
          tool_calls: kept.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        });
        const executed = await Promise.all(kept.map((c) => execute(c.name, c.args)));
        executed.forEach((r, i) => {
          messages.push({ role: "tool", tool_call_id: kept[i].id, content: JSON.stringify(forModel(r)) });
        });
      }
    } else {
      failure = llmDisabled() ? "the model was turned off (CROSSFIRE_NO_LLM)" : "no model key is configured";
    }

    // ---- the answer, or the fallbacks ----

    let final: { content: string; source: "model" | "fallback"; reason?: string } | undefined;

    // A proposal has no rows to cite yet, so the model cannot write a
    // checkable sentence about it. The card is the answer.
    if (results.some((r) => r.name === "start_run") && results.every((r) => r.citations.length === 0)) {
      final = { content: buildFallbackAnswer(results), source: "fallback", reason: "written by code: a proposal is reported, not phrased" };
    } else if (modelText !== undefined && results.length > 0) {
      final = finalizeAnswer(modelText, results, question);
      // One rewrite, told exactly what failed. The rows are already in hand, so
      // this costs a short call and nothing else; a second failure is final.
      if (final.source === "fallback" && remaining() >= MIN_MODEL_MS) {
        const citable = [...new Set(results.flatMap((r) => r.citations.map((c) => `[${c.table}#${c.id}]`)))];
        try {
          const reply = await model("assistant.rewrite", {
            messages: [
              ...messagesForRewrite(question, history, context, results, modelText),
              {
                role: "user",
                content: `That answer was rejected because ${final.reason}. Rewrite it in 2 to 4 sentences. Every sentence must end with at least one of these references exactly as written: ${citable.join(" ")}. Use only numbers that appear in the rows.`,
              },
            ],
          });
          const again = finalizeAnswer((reply.content ?? "").trim(), results, question);
          final = again.source === "model" ? again : { ...again, reason: `${final.reason}; after a rewrite, ${again.reason}` };
        } catch (err) {
          final = { ...final, reason: `${final.reason}; the rewrite failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
    } else if (modelText !== undefined) {
      // The model answered without reading anything. Fine for a greeting;
      // not for a claim about the books.
      const checked = finalizeAnswer(modelText, [], question);
      if (checked.source === "model") final = checked;
      else failure = `the model answered without a tool: ${checked.reason}`;
    }

    if (!final) {
      // Fallback 1: the router picks one tool.
      if (results.length === 0) {
        const chosen = forceTool
          ? { tool: forceTool, args: argsFor(forceTool, question, context) }
          : route(question, context);
        await execute(chosen.tool, chosen.args);
      }
      // Fallback 2: the model phrases the rows.
      if (modelAvailable(options) && !timedOut && remaining() >= MIN_MODEL_MS) {
        try {
          const reply = await model("assistant.phrase", {
            messages: [
              { role: "system", content: PHRASE_SYSTEM_PROMPT },
              { role: "user", content: `Question: ${question}\n\nRows:\n${JSON.stringify(results.map(forModel), null, 1)}` },
            ],
          });
          const phrased = finalizeAnswer((reply.content ?? "").trim(), results, question);
          final = phrased.source === "model" ? phrased : { ...phrased, reason: `${failure}; then ${phrased.reason}` };
        } catch (err) {
          final = {
            content: buildFallbackAnswer(results),
            source: "fallback",
            reason: `${failure}; then phrasing failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      } else {
        // Fallback 3: the rows, under a deterministic lede.
        final = { content: buildFallbackAnswer(results), source: "fallback", reason: failure ?? "no model call was made" };
      }
    }

    if (final.source === "fallback") {
      console.warn(`[assistant] answered from the rows: ${final.reason}`);
    }

    const draft = [...results].reverse().find((r) => r.draft)?.draft;
    const resolvedRunId =
      [...results].reverse().find((r) => r.resolvedRunId)?.resolvedRunId ??
      (await resolveRunArg(context.runId));

    return {
      content: final.content,
      toolCalls,
      toolResults: results.map((r) => {
        const { draft, ...rest } = r;
        void draft;
        return rest;
      }),
      draft,
      answerSource: final.source === "model" ? { source: "model" } : { source: "fallback", reason: final.reason },
      resolvedRunId,
      modelCalls,
      dropped,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- internals ----------

type ExecutedResult = AssistantToolResult & { draft?: AssistantDraft };

/** Runs one tool. A throwing handler becomes a result with an error. */
export async function executeTool(call: AssistantToolCall): Promise<ExecutedResult> {
  const startedAt = Date.now();
  if (!isToolName(call.name)) {
    return { name: call.name, args: call.args, rows: [], citations: [], error: `There is no tool named ${String(call.name)}.`, ms: 0 };
  }
  try {
    const result = await runTool(call.name, call.args ?? {});
    return { name: call.name, args: call.args ?? {}, ...result, ms: Date.now() - startedAt };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    console.error(`[assistant] tool ${call.name} failed`, { args: call.args, error: err });
    return {
      name: call.name,
      args: call.args ?? {},
      rows: [],
      citations: [],
      error: `${call.name.replace(/_/g, " ")} could not be read (${text.slice(0, 120)}).`,
      ms: Date.now() - startedAt,
    };
  }
}

type ParsedCalls = { ok: true; calls: { id: string; name: ToolName; args: ToolArgs }[] } | { ok: false; reason: string };

function parseToolCalls(raw: ChatCompletionMessageToolCall[] | undefined): ParsedCalls {
  if (!raw || raw.length === 0) return { ok: true, calls: [] };
  const calls: { id: string; name: ToolName; args: ToolArgs }[] = [];
  for (const c of raw) {
    if (c.type !== "function") return { ok: false, reason: `a tool call of type ${c.type}` };
    if (!isToolName(c.function.name)) return { ok: false, reason: `a call to an unknown tool ${c.function.name}` };
    let args: unknown = {};
    const text = c.function.arguments?.trim();
    if (text) {
      try {
        args = JSON.parse(text);
      } catch {
        return { ok: false, reason: `unparseable arguments for ${c.function.name}` };
      }
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return { ok: false, reason: `non-object arguments for ${c.function.name}` };
    }
    calls.push({ id: c.id || `call_${calls.length}`, name: c.function.name, args: args as ToolArgs });
  }
  return { ok: true, calls };
}

const MODEL_ROW_LIMIT = 40;
const MODEL_TEXT_LIMIT = 600;

/** The result as the model sees it: rows, the citable row ids, the note. */
function forModel(r: AssistantToolResult): Record<string, unknown> {
  const rows = r.rows.slice(0, MODEL_ROW_LIMIT).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, typeof v === "string" && v.length > MODEL_TEXT_LIMIT ? `${v.slice(0, MODEL_TEXT_LIMIT)}…` : v]),
    ),
  );
  return {
    tool: r.name,
    ...(r.resolvedRunId ? { run: r.resolvedRunId } : {}),
    rows,
    ...(r.rows.length > rows.length ? { rowsOmitted: r.rows.length - rows.length } : {}),
    citable: r.citations.map((c) => `${c.table}#${c.id}`),
    ...(r.note ? { note: r.note } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

/** The rewrite sees the question, the rows, and what it wrote — not the whole tool exchange. */
function messagesForRewrite(
  question: string,
  history: AssistantMessageView[],
  context: RouterContext,
  results: ExecutedResult[],
  rejected: string,
): ChatCompletionMessageParam[] {
  return [
    { role: "system", content: ASSISTANT_SYSTEM_PROMPT + contextLine(context) },
    ...history
      .filter((m) => m.content.trim().length > 0)
      .slice(-2)
      .map<ChatCompletionMessageParam>((m) =>
        m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content },
      ),
    { role: "user", content: `${question}\n\nRows already read:\n${JSON.stringify(results.map(forModel), null, 1)}` },
    { role: "assistant", content: rejected },
  ];
}

function contextLine(context: RouterContext): string {
  const parts: string[] = [];
  if (context.runId) parts.push(`The run in context is ${context.runId}; use it when the controller does not name one.`);
  if (context.sampleRef) parts.push(`The sample in context is ${context.sampleRef}.`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export { TOOL_BY_NAME };

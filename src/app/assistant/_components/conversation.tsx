"use client";

import { useEffect, useRef, useState } from "react";
import { Prose } from "@/app/_components/prose";
import type { AssistantMessageView, ToolName } from "@/lib/assistant/types";
import type { PendingTurn, RunContext } from "./assistant-workspace";
import { DraftCard, StartRunCard } from "./draft-card";
import { ToolResultTable } from "./tool-result-table";

const SUGGESTIONS: { label: string; question: string; forceTool?: ToolName }[] = [
  { label: "How did the last run go?", question: "How did the last run go?" },
  { label: "What is still waiting on me?", question: "What is still waiting on me?" },
  { label: "Where is our biggest exposure?", question: "Where is our biggest exposure?" },
  { label: "What did I rule on Stratus Compute?", question: "What did I rule on Stratus Compute before?" },
];

function sampleSuggestions(sampleRef: string): { label: string; question: string; forceTool?: ToolName }[] {
  return [
    { label: "Explain this gap", question: `Explain the gap on ${sampleRef}.`, forceTool: "explain_sample" },
    { label: "Draft an accept-with-note", question: `Draft an accept-with-note for ${sampleRef}.`, forceTool: "draft_note" },
    { label: "Draft a needs-more", question: `Draft a needs-more note for ${sampleRef}.`, forceTool: "draft_note" },
    { label: "Propose a remedy", question: `Propose a remedy for ${sampleRef}.`, forceTool: "propose_remedy" },
  ];
}

/** The centre column: the transcript, the states, and the composer. */
export function Conversation({
  messages,
  pending,
  error,
  runContext,
  sampleRef,
  onSend,
  onConfirmStartRun,
  onMessageUpdated,
}: {
  messages: AssistantMessageView[];
  pending: PendingTurn | null;
  error: { message: string; question: string; forceTool?: ToolName } | null;
  runContext: RunContext;
  sampleRef?: string;
  onSend: (question: string, forceTool?: ToolName) => void;
  onConfirmStartRun: (messageId: number) => void;
  onMessageUpdated: (message: AssistantMessageView) => void;
}) {
  const [text, setText] = useState("");
  const bottom = useRef<HTMLDivElement | null>(null);
  const empty = messages.length === 0 && !pending && !error;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending]);

  function submit() {
    const q = text.trim();
    if (!q || pending) return;
    setText("");
    onSend(q);
  }

  const suggestions = sampleRef ? sampleSuggestions(sampleRef) : SUGGESTIONS;

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-paper shadow-[0_5px_18px_rgba(0,0,0,0.045)]">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {empty ? (
          <div className="grid h-full place-items-center">
            <div className="max-w-md text-center">
              <p className="text-[13px]">Ask about the books or a run.</p>
              <p className="mt-1 text-[12.5px] text-ink-2">
                Every answer comes from the same rows the binder is built from, and cites them.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                {suggestions.map((s) => (
                  <button key={s.label} type="button" className="btn" onClick={() => onSend(s.question, s.forceTool)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <ol className="max-w-3xl space-y-5">
            {messages.map((m) => (
              <li key={m.id}>
                <Turn message={m} pendingStart={pending !== null} onConfirmStartRun={onConfirmStartRun} onMessageUpdated={onMessageUpdated} />
              </li>
            ))}
            {pending ? (
              <>
                <li>
                  <article className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4">
                    <div className="pt-px text-[12px] font-medium">You</div>
                    <p className="text-[13px] leading-relaxed">{pending.question}</p>
                  </article>
                </li>
                <li>
                  <article className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4">
                    <div className="pt-px text-[12px] font-medium text-ink-2">Assistant</div>
                    <div className="text-[11px] text-ink-3" aria-live="polite">
                      Reading the books…
                    </div>
                  </article>
                </li>
              </>
            ) : null}
            {error ? (
              <li>
                <article className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4">
                  <div className="pt-px text-[12px] font-medium text-ink-2">Assistant</div>
                  <div className="flex flex-wrap items-center gap-3 text-[12px] text-ink" role="alert">
                    <span>
                      <span className="mr-1 font-mono">△</span>
                      {error.message}
                    </span>
                    {error.question ? (
                      <button type="button" className="btn" onClick={() => onSend(error.question, error.forceTool)}>
                        Try again
                      </button>
                    ) : null}
                  </div>
                </article>
              </li>
            ) : null}
            <div ref={bottom} />
          </ol>
        )}
      </div>

      <div className="border-t border-line bg-paper px-5 py-3">
        {!empty ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {suggestions.slice(0, 4).map((s) => (
              <button key={s.label} type="button" className="btn" onClick={() => onSend(s.question, s.forceTool)} disabled={pending !== null}>
                {s.label}
              </button>
            ))}
          </div>
        ) : null}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={Math.min(4, Math.max(2, text.split("\n").length))}
            maxLength={2000}
            disabled={pending !== null}
            placeholder={
              runContext.runId === "mock"
                ? "Ask about the walkthrough…"
                : `Ask about run ${runContext.runId}${sampleRef ? ` or ${sampleRef}` : ""}…`
            }
            aria-label="Ask the assistant"
            className="input min-h-[56px] w-full resize-none py-1.5 leading-relaxed"
          />
          <button type="submit" className="btn btn-solid" disabled={pending !== null || text.trim().length === 0}>
            {pending ? "Asking…" : "Ask"}
          </button>
        </form>
      </div>
    </section>
  );
}

function assembledLabel(reason: string | undefined): string {
  const r = reason ?? "";
  if (r.startsWith("the model was turned off") || r.startsWith("written by code") || r.startsWith("no model key")) {
    return "Assembled from the rows.";
  }
  return "Assembled from the rows — the written answer did not check out.";
}

function Turn({
  message,
  pendingStart,
  onConfirmStartRun,
  onMessageUpdated,
}: {
  message: AssistantMessageView;
  pendingStart: boolean;
  onConfirmStartRun: (messageId: number) => void;
  onMessageUpdated: (message: AssistantMessageView) => void;
}) {
  const isUser = message.role === "user";
  const fallback = message.answerSource?.source === "fallback";
  const toolNames = message.toolCalls.map((c) => c.name);
  return (
    <article className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4">
      <div className="pt-px">
        <div className={`text-[12px] font-medium ${isUser ? "text-ink" : "text-ink-2"}`}>{isUser ? "You" : "Assistant"}</div>
        <div className="font-mono text-[11px] text-ink-3 num">turn {message.turn}</div>
      </div>
      <div className="min-w-0">
        {!isUser && fallback ? (
          <div className="mb-1 text-[11px] text-ink-3" title={message.answerSource?.reason || undefined}>
            {assembledLabel(message.answerSource?.reason)}
          </div>
        ) : null}
        <p className="text-[13px] leading-relaxed">
          <Prose text={message.content} />
        </p>
        {!isUser && fallback && message.toolResults.length > 0 ? (
          <div className="mt-2 space-y-2">
            {message.toolResults.map((r, i) => (
              <ToolResultTable key={`${r.name}-${i}`} result={r} />
            ))}
          </div>
        ) : null}
        {!isUser && toolNames.length > 0 ? (
          <div className="mt-1.5 text-[11px] text-ink-3">
            Read{" "}
            {toolNames.map((n, i) => (
              <span key={`${n}-${i}`}>
                {i > 0 ? " · " : ""}
                <span className="font-mono">{n}</span>
              </span>
            ))}
          </div>
        ) : null}
        {message.draft?.kind === "start_run" ? (
          <StartRunCard draft={message.draft} pending={pendingStart} onConfirm={() => onConfirmStartRun(message.id)} />
        ) : null}
        {message.draft && message.draft.kind !== "start_run" ? (
          <DraftCard message={message} draft={message.draft} onFiled={onMessageUpdated} />
        ) : null}
      </div>
    </article>
  );
}

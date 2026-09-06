"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AssistantMessageView,
  AssistantResponse,
  AssistantThreadView,
  ToolName,
} from "@/lib/assistant/types";
import { ContextPane } from "./context-pane";
import { Conversation } from "./conversation";
import { ThreadList } from "./thread-list";

export type RunContext = {
  runId: string;
  name: string;
  total?: number;
  defended?: number;
  gaps?: number;
  coverage?: number;
};

export type Opening = { message: string; forceTool: ToolName };

export type PendingTurn = { question: string; startedAt: number };

/**
 * The page's state: the open thread's messages, the question in flight, and
 * the last error. A new thread is created by the first answer; its id goes
 * into the URL with replaceState and into the thread list locally, so no
 * server round trip is needed to keep talking.
 */
export function AssistantWorkspace({
  threads: initialThreads,
  thread,
  initialMessages,
  runs,
  runContext,
  sampleRef,
  opening,
}: {
  threads: AssistantThreadView[];
  thread: AssistantThreadView | null;
  initialMessages: AssistantMessageView[];
  runs: { id: string; name: string }[];
  runContext: RunContext;
  sampleRef?: string;
  opening: Opening | null;
}) {
  const [threads, setThreads] = useState(initialThreads);
  const [threadId, setThreadId] = useState<number | null>(thread?.id ?? null);
  const [messages, setMessages] = useState(initialMessages);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [error, setError] = useState<{ message: string; question: string; forceTool?: ToolName } | null>(null);
  const [changing, setChanging] = useState(false);
  const openedRef = useRef(false);

  const send = useCallback(
    async (question: string, forceTool?: ToolName) => {
      const text = question.trim();
      if (!text || pending) return;
      setError(null);
      setPending({ question: text, startedAt: Date.now() });
      try {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: threadId ?? undefined,
            message: text,
            runId: runContext.runId,
            sampleRef,
            forceTool,
          }),
        });
        const body = (await res.json()) as AssistantResponse;
        if (!body.ok) {
          setError({ message: body.message, question: text, forceTool });
          return;
        }
        const userTurn: AssistantMessageView = {
          id: -body.message.id,
          threadId: body.threadId,
          turn: body.message.turn - 1,
          role: "user",
          content: text,
          toolCalls: [],
          toolResults: [],
          citations: [],
          createdAt: new Date().toISOString(),
        };
        setMessages((current) => [...current, userTurn, body.message]);
        if (threadId === null) {
          setThreadId(body.threadId);
          const now = new Date().toISOString();
          setThreads((current) => [
            { id: body.threadId, title: text.slice(0, 80), runId: runContext.runId, createdAt: now, updatedAt: now, messageCount: 2 },
            ...current,
          ]);
          window.history.replaceState(null, "", `/assistant?thread=${body.threadId}`);
        } else {
          setThreads((current) =>
            current.map((t) =>
              t.id === threadId ? { ...t, updatedAt: new Date().toISOString(), messageCount: t.messageCount + 2 } : t,
            ),
          );
        }
      } catch {
        setError({ message: "The assistant could not be reached. Try again.", question: text, forceTool });
      } finally {
        setPending(null);
      }
    },
    [pending, threadId, runContext.runId, sampleRef],
  );

  // A chip from the run screen: the opening question is sent once on mount.
  useEffect(() => {
    if (!opening || openedRef.current || threadId !== null) return;
    openedRef.current = true;
    void send(opening.message, opening.forceTool);
  }, [opening, threadId, send]);

  const confirmStartRun = useCallback(
    async (messageId: number) => {
      if (threadId === null || pending) return;
      setError(null);
      setPending({ question: "Start run", startedAt: Date.now() });
      try {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadId, message: "Start run", confirmStartRun: messageId }),
        });
        const body = (await res.json()) as AssistantResponse;
        if (!body.ok) {
          setError({ message: body.message, question: "" });
          return;
        }
        setMessages((current) => [
          ...current.map((m) =>
            m.id === messageId && m.draft?.kind === "start_run"
              ? { ...m, draft: { ...m.draft, startedRunId: Number(body.resolvedRunId) } }
              : m,
          ),
          body.message,
        ]);
      } catch {
        setError({ message: "The run could not be started. Try again.", question: "" });
      } finally {
        setPending(null);
      }
    },
    [threadId, pending],
  );

  const updateMessage = useCallback((updated: AssistantMessageView) => {
    setMessages((current) => current.map((m) => (m.id === updated.id ? updated : m)));
  }, []);

  const latestAnswer = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <header className="flex h-12 shrink-0 items-center justify-between gap-6 border-b border-line pl-[var(--shell-header-left,1rem)] pr-4">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-[13.5px] font-semibold tracking-tight">Assistant</h1>
          <div className="relative flex items-baseline gap-2 font-mono text-[11px] text-ink-3 num">
            <span>{runContext.runId === "mock" ? "walkthrough" : `run ${runContext.runId}`}</span>
            {sampleRef ? (
              <>
                <span className="text-line-2">|</span>
                <span>{sampleRef}</span>
              </>
            ) : null}
            {threadId === null ? (
              <button
                type="button"
                onClick={() => setChanging((v) => !v)}
                aria-expanded={changing}
                className="font-sans text-[11px] text-ink-2 underline underline-offset-2 hover:text-ink"
              >
                Change
              </button>
            ) : null}
            {changing ? (
              <div className="absolute left-0 top-full z-30 mt-2 w-64 rounded-xl border border-line bg-paper p-1.5 font-sans shadow-[0_14px_40px_rgba(0,0,0,0.12)]">
                <div className="px-2 pb-1 pt-1 text-[11.5px] text-ink-3">Run in context</div>
                <ul className="max-h-72 overflow-y-auto">
                  {runs.map((run) => (
                    <li key={run.id}>
                      <Link
                        href={`/assistant?run=${run.id}`}
                        className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] hover:bg-paper-2 ${run.id === runContext.runId ? "bg-accent-soft" : ""}`}
                      >
                        <span className="font-mono text-[11px] text-ink-3 num">{run.id}</span>
                        <span className="truncate">{run.name}</span>
                      </Link>
                    </li>
                  ))}
                  <li>
                    <Link
                      href="/assistant?run=mock"
                      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] hover:bg-paper-2 ${runContext.runId === "mock" ? "bg-accent-soft" : ""}`}
                    >
                      <span className="font-mono text-[11px] text-ink-3">◇</span>
                      <span>Walkthrough</span>
                    </Link>
                  </li>
                </ul>
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link className="btn" href={`/audit/${encodeURIComponent(runContext.runId)}`}>
            Open run
          </Link>
          <Link className="btn" href={`/assistant?run=${encodeURIComponent(runContext.runId)}`}>
            New thread
          </Link>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 overflow-x-auto bg-paper-2 p-3 grid-cols-[16rem_minmax(20rem,1fr)] lg:grid-cols-[17rem_minmax(22rem,1fr)_17rem] xl:grid-cols-[20rem_minmax(26rem,1fr)_21rem]">
        <ThreadList threads={threads} selectedId={threadId} />
        <Conversation
          messages={messages}
          pending={pending}
          error={error}
          runContext={runContext}
          sampleRef={sampleRef}
          onSend={send}
          onConfirmStartRun={confirmStartRun}
          onMessageUpdated={updateMessage}
        />
        <ContextPane runContext={runContext} answer={latestAnswer} />
      </div>
    </div>
  );
}

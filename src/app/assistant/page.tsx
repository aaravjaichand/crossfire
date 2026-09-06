import { getThread, listMessages, listThreads } from "@/lib/assistant/threads";
import { isChipAsk, type AssistantMessageView, type AssistantThreadView, type ToolName } from "@/lib/assistant/types";
import { counterpartyOf, getSample } from "@/lib/referee/data";
import { parseSampleId } from "@/lib/referee/sample-id";
import { recentRuns, type RunSummary } from "@/lib/referee/runs";
import { AssistantWorkspace, type Opening, type RunContext } from "./_components/assistant-workspace";

export const dynamic = "force-dynamic";

type Query = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Three columns: threads, the conversation, the citations. Everything the
 * page needs is loaded here and handed down; the client posts questions to
 * /api/assistant and keeps its own copy of the open thread.
 *
 * ?run and ?sample set the context a new thread is opened with. ?ask is a
 * closed enum from the run screen's chips; it maps to a fixed opening
 * question and a named tool, and the client sends it once on mount.
 */
export default async function AssistantPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const threadParam = first(query.thread);
  const threadId = threadParam && /^\d+$/.test(threadParam) ? Number(threadParam) : undefined;
  const runParam = first(query.run);
  const sampleParam = first(query.sample);
  const askParam = first(query.ask);

  let threads: AssistantThreadView[] = [];
  let thread: AssistantThreadView | null = null;
  let messages: AssistantMessageView[] = [];
  let runs: RunSummary[] = [];
  try {
    [threads, runs, thread] = await Promise.all([
      listThreads(),
      recentRuns(12),
      threadId === undefined ? Promise.resolve(null) : getThread(threadId),
    ]);
    if (thread) messages = await listMessages(thread.id);
  } catch (error) {
    console.error("[assistant] loading the page failed", { error });
    return <Unavailable />;
  }

  const latest = runs[0];
  const runKey =
    thread?.runId ??
    (runParam && /^(\d+|mock)$/.test(runParam) ? runParam : undefined) ??
    (latest ? String(latest.id) : "mock");
  const sampleRef = sampleParam && parseSampleId(sampleParam) ? sampleParam : undefined;

  const summary = runs.find((r) => String(r.id) === runKey);
  const runContext: RunContext = {
    runId: runKey,
    name: summary?.name ?? (runKey === "mock" ? "Walkthrough" : `Run ${runKey}`),
    total: summary?.total,
    defended: summary?.defended,
    gaps: summary?.gap,
    coverage: summary && summary.total > 0 ? Math.round((summary.defended / summary.total) * 100) : undefined,
  };

  // The chip's opening: a fixed question and the tool it already knows.
  let opening: Opening | null = null;
  if (!thread && sampleRef && isChipAsk(askParam)) {
    if (askParam === "explain_gap") {
      opening = { message: `Explain the gap on ${sampleRef}.`, forceTool: "explain_sample" };
    } else if (askParam === "draft_accept") {
      opening = { message: `Draft an accept-with-note for ${sampleRef}.`, forceTool: "draft_note" };
    } else {
      // prior_rulings needs the counterparty, read off the sample here so the
      // question names it and the router can extract it with the model off.
      let counterparty = "";
      try {
        const sample = await getSample(runKey, sampleRef);
        counterparty = sample ? counterpartyOf(sample) : "";
      } catch (error) {
        console.error("[assistant] reading the sample for a chip failed", { runKey, sampleRef, error });
      }
      opening = {
        message: counterparty
          ? `What did I rule on ${counterparty} before, and are there similar items in earlier runs?`
          : `What did I rule before on items like ${sampleRef}?`,
        forceTool: "prior_rulings" satisfies ToolName,
      };
    }
  }

  return (
    <AssistantWorkspace
      key={thread?.id ?? `new-${runKey}-${sampleRef ?? ""}-${askParam ?? ""}`}
      threads={threads}
      thread={thread}
      initialMessages={messages}
      runs={runs.map((r) => ({ id: String(r.id), name: r.name }))}
      runContext={runContext}
      sampleRef={sampleRef}
      opening={opening}
    />
  );
}

function Unavailable() {
  return (
    <main className="mx-auto w-full max-w-2xl px-8 py-10">
      <h1 className="text-[20px] font-semibold tracking-tight">The assistant could not be loaded</h1>
      <p className="mt-2 text-[13px] text-ink-2">
        Reading the threads failed. The details are in the server log. On a fresh checkout the
        tables may not exist yet: run{" "}
        <code className="rounded-[3px] bg-paper-2 px-1.5 py-0.5 font-mono text-[12px]">pnpm db:push</code>{" "}
        and reload.
      </p>
    </main>
  );
}

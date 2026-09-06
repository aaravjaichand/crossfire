/**
 * pnpm assistant:check
 *
 * The controller's assistant with the model off (CROSSFIRE_NO_LLM=1), against
 * the seeded database. Makes no network call. Two small fixture runs are
 * started through the start_run tool's executor — the same inputs
 * engine:check uses, which force the planted over-rate invoice into the sample
 * so a gap is guaranteed — with one ruling filed between them, and both are
 * deleted again at the end.
 *
 *   1. Every tool returns rows with ids, and the counterparty string exposure
 *      groups on is the one prior_rulings finds.
 *   2. runId defaulting resolves to the most recent run and is echoed back.
 *   3. The router handles the fifteen canned questions, regex path only.
 *   4. Enforcement rejects a fabricated number and a fabricated citation and
 *      passes a correct answer.
 *   5. A draft writes nothing: referee_decisions, learned_rules, audit_samples
 *      counts and the sample's status are unchanged after draft_note and
 *      propose_remedy.
 *   6. No tool can mutate a sample: every registry entry is read or draft
 *      except start_run, and no tool-side source file imports a writer.
 *   7. The loop is bounded: a stub that returns a tool call every round is
 *      stopped after MAX_ROUNDS and answers from the rows it has; repeated
 *      calls are deduplicated; a failing model still answers with rows.
 *   8. Draft handoff verification refuses a draft under another run or
 *      against another sample.
 */
import "@/lib/referee/load-env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, count, eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "@/db";
import { getRun, type SampleView } from "@/lib/referee/data";
import { recordDecision } from "@/lib/referee/decide";
import { recentRuns } from "@/lib/referee/runs";
import { parseSampleId } from "@/lib/referee/sample-id";
import { finalizeAnswer } from "./answer";
import { resolveRunArg } from "./handlers";
import { verifyDraft } from "./handoff";
import { answerQuestion, MAX_CALLS_PER_ROUND, MAX_ROUNDS, type ChatFn } from "./loop";
import { route } from "./router";
import { executeStartRun } from "./start-run";
import { appendMessage, createThread } from "./threads";
import { TOOLS, runTool } from "./tools";
import type { AssistantToolResult, RulingDraft, ToolArgs, ToolName } from "./types";

process.env.CROSSFIRE_NO_LLM = "1";
process.env.CROSSFIRE_NO_TRACING = "1";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// The engine:check recipe: just under the planted over-rate invoice, purchases
// only, so invoice #5 and its settling payment are always drawn.
const FIXTURE = { seed: 7, materiality: 2_100_000, sampleSize: 6, cycles: ["purchases"] };

const fixtureRunIds: number[] = [];
const fixtureThreadIds: number[] = [];

async function waitForRun(runId: number, timeoutMs = 120_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const [row] = await db
      .select({ status: schema.auditRuns.status })
      .from(schema.auditRuns)
      .where(eq(schema.auditRuns.id, runId));
    if (row && row.status !== "running") return row.status;
    if (Date.now() - started > timeoutMs) return row?.status ?? "(missing)";
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function startFixtureRun(label: string): Promise<{ runId: number; result: AssistantToolResult }> {
  const result = await executeStartRun({ ...FIXTURE, name: `Assistant check ${label} ${Date.now()}` });
  const runId = Number(result.rows[0]?.run);
  fixtureRunIds.push(runId);
  const status = await waitForRun(runId);
  check(`fixture run ${label} (#${runId}) completed with the model off`, status === "complete", status);
  return { runId, result: { name: "start_run", args: FIXTURE, ...result } };
}

type Counts = { decisions: number; rules: number; samples: number };

async function counts(): Promise<Counts> {
  const [[d], [r], [s]] = await Promise.all([
    db.select({ n: count() }).from(schema.refereeDecisions),
    db.select({ n: count() }).from(schema.learnedRules),
    db.select({ n: count() }).from(schema.auditSamples),
  ]);
  return { decisions: d.n, rules: r.n, samples: s.n };
}

async function sampleState(runId: number, sample: SampleView) {
  const ref = parseSampleId(sample.id)!;
  const [row] = await db
    .select({
      status: schema.auditSamples.status,
      resolution: schema.auditSamples.resolution,
      pendingFollowUp: schema.auditSamples.pendingFollowUp,
    })
    .from(schema.auditSamples)
    .where(
      and(
        eq(schema.auditSamples.runId, runId),
        eq(schema.auditSamples.sampleType, ref.type),
        eq(schema.auditSamples.sampleId, ref.id),
      ),
    );
  return JSON.stringify(row);
}

function wellFormed(result: AssistantToolResult): string | null {
  for (const c of result.citations) {
    if (typeof c.table !== "string" || !/^[a-z_]+$/.test(c.table)) return `bad table ${JSON.stringify(c.table)}`;
    if (!Number.isInteger(c.id) || c.id <= 0) return `bad id ${JSON.stringify(c.id)} on ${c.table}`;
  }
  return null;
}

async function cleanup() {
  if (fixtureThreadIds.length > 0) {
    await db.delete(schema.assistantMessages).where(inArray(schema.assistantMessages.threadId, fixtureThreadIds));
    await db.delete(schema.assistantThreads).where(inArray(schema.assistantThreads.id, fixtureThreadIds));
  }
  if (fixtureRunIds.length > 0) {
    const keys = fixtureRunIds.map(String);
    await db.delete(schema.auditExchanges).where(inArray(schema.auditExchanges.runId, fixtureRunIds));
    await db.delete(schema.auditSamples).where(inArray(schema.auditSamples.runId, fixtureRunIds));
    await db.delete(schema.learnedRules).where(inArray(schema.learnedRules.runId, keys));
    await db.delete(schema.refereeDecisions).where(inArray(schema.refereeDecisions.runId, keys));
    await db.delete(schema.auditRuns).where(inArray(schema.auditRuns.id, fixtureRunIds));
  }
}

async function main() {
  // ---- fixtures ----
  const a = await startFixtureRun("A");
  const runA = await getRun(String(a.runId));
  const gapsA = runA?.samples.filter((s) => s.status === "gap") ?? [];
  check("fixture run A has at least one gap to rule on", gapsA.length > 0, `${gapsA.length} gaps`);
  if (!runA || gapsA.length === 0) throw new Error("no gap in the fixture run; cannot continue");

  const toRule = gapsA[0];
  const ruledRef = parseSampleId(toRule.id)!;
  const exposureBefore = await runTool("exposure_by_counterparty", { runId: String(a.runId) });
  const exposureRow = exposureBefore.rows.find((r) => String(r.sampleIds).split(", ").includes(toRule.id));
  const exposureCounterparty = String(exposureRow?.counterparty ?? "");

  const ruling = await recordDecision(
    { runId: String(a.runId), sampleType: ruledRef.type, sampleId: ruledRef.id },
    "accepted_with_note",
    { note: `Assistant check fixture: accepted ${toRule.label} for this pass.` },
  );
  check("fixture ruling filed on run A (accepted_with_note)", ruling.ok, ruling.ok ? toRule.id : ruling.message);

  const b = await startFixtureRun("B");
  const runB = await getRun(String(b.runId));
  const gapsB = runB?.samples.filter((s) => s.status === "gap") ?? [];
  check("fixture run B has at least one gap", gapsB.length > 0, `${gapsB.length} gaps`);
  if (!runB || gapsB.length === 0) throw new Error("no gap in fixture run B; cannot continue");
  const gapB = gapsB[0];
  const latest = (await recentRuns(1))[0];
  check("the most recent run is fixture run B", latest?.id === b.runId, `recentRuns(1) = ${latest?.id}`);

  // ---- 1. every tool returns rows with ids ----
  console.log("\n1. every tool returns rows with ids");
  const before1 = await counts();
  const calls: [ToolName, ToolArgs][] = [
    ["run_summary", { runId: String(b.runId) }],
    ["list_gaps", { runId: String(b.runId) }],
    ["explain_sample", { runId: String(b.runId), sampleRef: gapB.id }],
    ["exposure_by_counterparty", { runId: String(b.runId) }],
    ["prior_rulings", { counterparty: exposureCounterparty }],
    ["compare_runs", { runId: String(b.runId), previousRunId: String(a.runId) }],
    ["where_is", { runId: String(b.runId), query: gapB.id }],
    ["draft_note", { runId: String(b.runId), sampleRef: gapB.id, verdict: "accepted_with_note" }],
    ["propose_remedy", { runId: String(b.runId), sampleRef: gapB.id }],
  ];
  const timings: string[] = [];
  for (const [name, args] of calls) {
    const t = Date.now();
    const result = { name, args, ...(await runTool(name, args)) };
    timings.push(`${name} ${Date.now() - t}ms`);
    const malformed = wellFormed(result);
    check(
      `${name} returns rows with well-formed citations`,
      result.rows.length > 0 && result.citations.length > 0 && !malformed,
      malformed ?? `${result.rows.length} rows, ${result.citations.length} citations${result.note ? `; ${result.note}` : ""}`,
    );
  }
  {
    const malformed = wellFormed(b.result);
    check(
      "start_run (confirmed) returns the new run with an audit_runs citation",
      b.result.rows.length === 1 && b.result.citations[0]?.table === "audit_runs" && b.result.citations[0]?.id === b.runId && !malformed,
      malformed ?? `audit_runs#${b.result.citations[0]?.id}`,
    );
    const proposal = await runTool("start_run", { seed: 3, sampleSize: 10, materiality: 50_000 });
    check(
      "start_run (from the model) only proposes: parameters back, no run, no citation",
      proposal.draft?.kind === "start_run" && proposal.draft.params.seed === 3 && proposal.citations.length === 0 && (await recentRuns(1))[0]?.id === b.runId,
      JSON.stringify(proposal.rows[0]),
    );
  }
  const after1 = await counts();
  check(
    "no read or draft tool wrote a decision, a rule, or a sample",
    JSON.stringify(before1) === JSON.stringify(after1),
    `${JSON.stringify(before1)} → ${JSON.stringify(after1)}`,
  );
  {
    const [rule] = await db
      .select()
      .from(schema.learnedRules)
      .where(and(eq(schema.learnedRules.runId, String(a.runId)), eq(schema.learnedRules.sampleId, ruledRef.id)));
    const prior = await runTool("prior_rulings", { counterparty: exposureCounterparty });
    check(
      "the counterparty exposure groups on is the one the rule was filed under and prior_rulings finds",
      Boolean(rule) && rule.counterparty === exposureCounterparty && prior.citations.some((c) => c.table === "learned_rules" && c.id === rule.id),
      `"${exposureCounterparty}" vs "${rule?.counterparty}"`,
    );
    const summary = await runTool("run_summary", { runId: String(b.runId) });
    check(
      "run B reports the sample memory settled from run A's ruling",
      Number(summary.rows[0]?.resolvedByMemory) >= 1,
      `resolvedByMemory = ${summary.rows[0]?.resolvedByMemory}`,
    );
  }
  console.log(`    timings: ${timings.join(", ")}`);

  // ---- 2. runId defaulting ----
  console.log("\n2. runId defaulting");
  const defaulted: [ToolName, ToolArgs][] = [
    ["run_summary", {}],
    ["list_gaps", {}],
    ["explain_sample", { sampleRef: gapB.id }],
    ["exposure_by_counterparty", {}],
    ["where_is", { query: "binder" }],
    ["draft_note", { sampleRef: gapB.id, verdict: "needs_more" }],
    ["propose_remedy", { sampleRef: gapB.id }],
  ];
  check("resolveRunArg() with nothing resolves to recentRuns(1)[0].id", (await resolveRunArg(undefined)) === String(b.runId));
  check('resolveRunArg("mock") is the walkthrough', (await resolveRunArg("mock")) === "mock");
  check('resolveRunArg("run 7") is "7"', (await resolveRunArg("run 7")) === "7");
  for (const [name, args] of defaulted) {
    const result = await runTool(name, args);
    check(`${name} with runId omitted echoes run ${b.runId}`, result.resolvedRunId === String(b.runId), `resolvedRunId = ${result.resolvedRunId}`);
  }
  {
    const cmp = await runTool("compare_runs", {});
    check("compare_runs with both ids omitted resolves the latest comparable pair", cmp.resolvedRunId === String(b.runId) && cmp.rows.some((r) => r.side === "previous" && r.run === String(a.runId)), `resolved ${cmp.resolvedRunId}${cmp.note ? `; ${cmp.note}` : ""}`);
  }

  // ---- 3. the router ----
  console.log("\n3. the router handles the fifteen canned questions (model off)");
  const canned: [string, ToolName, ToolArgs][] = [
    ["how did the last run go", "run_summary", {}],
    ["what's still waiting on me", "list_gaps", {}],
    ["show me the gaps", "list_gaps", {}],
    ["gaps for Stratus Compute", "list_gaps", { counterparty: "Stratus Compute" }],
    ["rate mismatch gaps in run 7", "list_gaps", { kind: "rate_mismatch", runId: "7" }],
    ["explain invoice:24", "explain_sample", { sampleRef: "invoice:24" }],
    ["what happened with bank:109", "explain_sample", { sampleRef: "bank:109" }],
    ["where is our biggest exposure", "exposure_by_counterparty", {}],
    ["how much are we exposed to Meridian Freight", "exposure_by_counterparty", { counterparty: "Meridian Freight" }],
    ["what did I rule on Stratus Compute before", "prior_rulings", { counterparty: "Stratus Compute" }],
    ["compare the last two runs", "compare_runs", {}],
    ["did coverage improve", "compare_runs", {}],
    ["open the binder for run 7", "where_is", { query: "binder", runId: "7" }],
    ["draft an accept-with-note for invoice:24", "draft_note", { sampleRef: "invoice:24", verdict: "accepted_with_note" }],
    ["start a run with seed 3 and 10 samples", "start_run", { seed: 3, sampleSize: 10 }],
  ];
  for (const [question, tool, expected] of canned) {
    const chosen = route(question);
    const argsOk = Object.entries(expected).every(([k, v]) => JSON.stringify(chosen.args[k]) === JSON.stringify(v));
    const extra = Object.keys(chosen.args).filter((k) => !(k in expected));
    check(
      `"${question}" → ${tool}${Object.keys(expected).length ? ` ${JSON.stringify(expected)}` : ""}`,
      chosen.tool === tool && argsOk && extra.length === 0,
      `got ${chosen.tool} ${JSON.stringify(chosen.args)}`,
    );
  }
  {
    const chosen = route("start a run with seed 3 and 10 samples");
    const proposal = await runTool(chosen.tool, chosen.args);
    check(
      "the start_run proposal normalizes to {seed: 3, sampleSize: 10}",
      proposal.draft?.kind === "start_run" && proposal.draft.params.seed === 3 && proposal.draft.params.sampleSize === 10,
      JSON.stringify(proposal.draft),
    );
  }

  // ---- 4. enforcement ----
  console.log("\n4. enforcement");
  const probeB: AssistantToolResult[] = [
    {
      name: "run_summary",
      args: {},
      rows: [{ run: "7", samples: 25, defended: 21, gapsUnruled: 4, exceptions: 3, coveragePercent: 88 }],
      citations: [{ table: "audit_runs", id: 7, field: "name", value: "Run 7", reason: "The run." }],
      resolvedRunId: "7",
    },
  ];
  const fabricatedNumber = finalizeAnswer("Run 7 finished with 84% of samples being successfully defended [audit_runs#7].", probeB);
  check("a fabricated number (84%) is rejected", fabricatedNumber.source === "fallback", fabricatedNumber.reason);
  const fabricatedRow = finalizeAnswer("Run 7 defended 21 of 25 samples [invoices#9999].", probeB);
  check("a fabricated citation ([invoices#9999]) is rejected", fabricatedRow.source === "fallback", fabricatedRow.reason);
  const correct = finalizeAnswer("Run 7 defended 21 of 25 samples, for 88% coverage, with 4 gaps still waiting on you [audit_runs#7].", probeB);
  check("a correct answer over the same rows passes as model", correct.source === "model", correct.reason ?? correct.content);
  const uncited = finalizeAnswer("Run 7 defended 21 of 25 samples.", probeB);
  check("an uncited factual sentence is rejected", uncited.source === "fallback", uncited.reason);
  check("the fallback lede cites the run", fabricatedNumber.content.includes("[audit_runs#7]"), fabricatedNumber.content);

  // ---- 5. a draft writes nothing ----
  console.log("\n5. a draft writes nothing");
  const before5 = await counts();
  const state5 = await sampleState(b.runId, gapB);
  for (const verdict of ["needs_more", "accepted_with_note", "exception"]) {
    const d = await runTool("draft_note", { runId: String(b.runId), sampleRef: gapB.id, verdict });
    const draft = d.draft as RulingDraft | undefined;
    check(
      `draft_note(${verdict}) returns a cited draft under 500 characters`,
      draft?.kind === "note" && draft.verdict === verdict && draft.text.length > 0 && draft.text.length <= 500 && draft.citations.length > 0 && /\[[a-z_]+#\d+\]/.test(draft.text),
      draft?.text,
    );
  }
  const remedy = await runTool("propose_remedy", { runId: String(b.runId), sampleRef: gapB.id });
  check(
    "propose_remedy returns a remedy and the same entry the exception panel shows",
    remedy.draft?.kind === "remedy" && Boolean(remedy.draft.remedy) && Boolean(remedy.draft.entry?.amount),
    `${remedy.draft?.kind === "remedy" ? `${remedy.draft.remedy} · ${remedy.draft.entry?.amount}` : ""}`,
  );
  const after5 = await counts();
  check("referee_decisions, learned_rules, audit_samples counts unchanged", JSON.stringify(before5) === JSON.stringify(after5), `${JSON.stringify(before5)} → ${JSON.stringify(after5)}`);
  check("the sample's status, resolution, and pending_follow_up unchanged", (await sampleState(b.runId, gapB)) === state5, state5);

  // ---- 6. no tool can mutate a sample ----
  console.log("\n6. no tool can mutate a sample");
  const kinds = TOOLS.map((t) => `${t.name}:${t.kind}`);
  check(
    "every registry entry is read or draft except start_run",
    TOOLS.every((t) => (t.name === "start_run" ? t.kind === "action" : t.kind === "read" || t.kind === "draft")) && TOOLS.length === 10,
    kinds.join(", "),
  );
  const dir = path.join(process.cwd(), "src/lib/assistant");
  const toolSide = ["tools.ts", "handlers.ts", "router.ts", "answer.ts", "remedies.ts", "prompt.ts", "types.ts"];
  const writerCalls = ["recordDecision", "submitVerdict", "db.update", "db.insert", "db.delete", ".insert(", ".update(", ".delete(", "tx.insert", "tx.update"];
  const writerModules = ["referee/actions", "engine/start", "assistant/actions", "./start-run", "./actions", "./loop", "./threads"];
  for (const file of toolSide) {
    const src = readFileSync(path.join(dir, file), "utf8");
    // Comments may name a file; only an import reaches it.
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    const hits = [
      ...writerCalls.filter((w) => src.includes(w)),
      ...imports.filter((i) => writerModules.some((w) => i === w || i.endsWith(w))),
    ];
    check(`${file} imports no writer`, hits.length === 0, hits.join(", ") || "clean");
  }
  {
    const startRunSrc = readFileSync(path.join(dir, "start-run.ts"), "utf8");
    const loopSrc = readFileSync(path.join(dir, "loop.ts"), "utf8");
    const importsOf = (src: string) => [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    const toolsImports = importsOf(readFileSync(path.join(dir, "tools.ts"), "utf8"));
    const handlersImports = importsOf(readFileSync(path.join(dir, "handlers.ts"), "utf8"));
    check(
      'start-run.ts is the only tool file that reaches the "use server" engine; tools.ts and handlers.ts do not import it',
      importsOf(startRunSrc).includes("@/lib/engine/start") &&
        !toolsImports.some((i) => i.includes("start-run") || i.includes("engine/start")) &&
        !handlersImports.some((i) => i.includes("start-run") || i.includes("engine/start")) &&
        !importsOf(loopSrc).some((i) => i.includes("referee/actions")),
      `tools.ts imports ${toolsImports.join(", ")}`,
    );
  }

  // ---- 7. the loop is bounded ----
  console.log("\n7. the loop is bounded");
  {
    let rounds = 0;
    let toolsOffered: boolean[] = [];
    const greedy: ChatFn = async (opts) => {
      rounds += 1;
      toolsOffered.push(Boolean(opts.tools));
      if (opts.toolChoice === "required") throw new Error("required must never be sent");
      if (!opts.tools) return { role: "assistant", content: "Nothing more to add.", refusal: null, finish_reason: "stop" };
      return {
        role: "assistant",
        content: null,
        refusal: null,
        finish_reason: "tool_calls",
        tool_calls: Array.from({ length: 6 }, (_, i) => ({
          id: `call_${rounds}_${i}`,
          type: "function" as const,
          function: { name: "run_summary", arguments: JSON.stringify({ runId: String(rounds * 10 + i) }) },
        })),
      };
    };
    const answer = await answerQuestion("keep going", [], {}, undefined, { chat: greedy });
    // The rounds after MAX_ROUNDS carry no tools: the answer, then at most
    // one rewrite when the answer did not check out.
    check(
      `a model that calls tools every round is stopped after ${MAX_ROUNDS} rounds and asked to answer without tools`,
      rounds >= MAX_ROUNDS + 1 &&
        rounds <= MAX_ROUNDS + 2 &&
        toolsOffered.slice(0, MAX_ROUNDS).every(Boolean) &&
        toolsOffered.slice(MAX_ROUNDS).every((offered) => offered === false),
      `${rounds} model calls, tools offered: ${toolsOffered.join(",")}`,
    );
    check(
      `at most ${MAX_CALLS_PER_ROUND} calls per round run; the rest are dropped`,
      answer.toolResults.length === MAX_ROUNDS * MAX_CALLS_PER_ROUND && answer.dropped === MAX_ROUNDS * 2,
      `${answer.toolResults.length} run, ${answer.dropped} dropped`,
    );
    check("it still answers from the rows it has", answer.content.length > 0 && answer.answerSource.source === "fallback", answer.answerSource.reason);

    let calls = 0;
    const repetitive: ChatFn = async (opts) => {
      calls += 1;
      if (!opts.tools) return { role: "assistant", content: "Done.", refusal: null, finish_reason: "stop" };
      return {
        role: "assistant",
        content: null,
        refusal: null,
        finish_reason: "tool_calls",
        tool_calls: Array.from({ length: 10 }, (_, i) => ({
          id: `dup_${calls}_${i}`,
          type: "function" as const,
          function: { name: "run_summary", arguments: JSON.stringify({ runId: String(b.runId) }) },
        })),
      };
    };
    toolsOffered = [];
    const deduped = await answerQuestion("again", [], {}, undefined, { chat: repetitive });
    check("ten identical calls in a round run once", deduped.toolResults.length === 1 && deduped.dropped >= 9, `${deduped.toolResults.length} run, ${deduped.dropped} dropped`);

    const failing: ChatFn = async () => {
      throw new Error("503 from the endpoint");
    };
    const failed = await answerQuestion("how did the last run go", [], {}, undefined, { chat: failing });
    check(
      "a failing model still answers: the router picks run_summary and the rows render",
      failed.toolCalls[0]?.name === "run_summary" && failed.toolResults[0]?.rows.length === 1 && failed.answerSource.source === "fallback" && failed.content.includes(`[audit_runs#${b.runId}]`),
      `${failed.toolCalls.map((c) => c.name).join(",")}: ${failed.answerSource.reason}`,
    );
    check("the failed turn resolved the run it answered about", failed.resolvedRunId === String(b.runId), failed.resolvedRunId);

    const offAnswer = await answerQuestion("what did I rule on " + exposureCounterparty + " before", [], {}, undefined, {});
    check(
      "with the model off, a question about prior rulings routes to prior_rulings and cites the rule",
      offAnswer.toolCalls[0]?.name === "prior_rulings" && offAnswer.content.includes("[learned_rules#"),
      offAnswer.content.slice(0, 160),
    );
    const forced = await answerQuestion("Draft an accept-with-note for " + gapB.id, [], { runId: String(b.runId), sampleRef: gapB.id }, "draft_note", {});
    check(
      "a chip's forced tool runs with the model off and yields a draft aimed at the run and sample",
      forced.toolCalls[0]?.name === "draft_note" && forced.draft?.kind === "note" && forced.draft.runId === String(b.runId) && forced.draft.sampleRef === gapB.id,
      forced.draft?.kind === "note" ? forced.draft.text.slice(0, 120) : JSON.stringify(forced.toolCalls),
    );
  }

  // ---- 8. draft handoff verification ----
  console.log("\n8. draft handoff verification");
  {
    const threadId = await createThread("Assistant check thread", String(b.runId));
    fixtureThreadIds.push(threadId);
    const drafted = await runTool("draft_note", { runId: String(b.runId), sampleRef: gapB.id, verdict: "accepted_with_note" });
    const message = await appendMessage({
      threadId,
      role: "assistant",
      content: "draft",
      draft: drafted.draft,
      runId: String(b.runId),
      sampleRef: gapB.id,
    });
    const draft = message.draft as RulingDraft;
    const other = runB.samples.find((s) => s.id !== gapB.id)?.id ?? "bank:1";
    check("the draft is accepted under its own run and sample", verifyDraft(draft, message.id, String(b.runId), gapB.id)?.note === draft.text);
    check("the draft is refused under another run", verifyDraft(draft, message.id, String(a.runId), gapB.id) === null);
    check("the draft is refused against another sample", verifyDraft(draft, message.id, String(b.runId), other) === null);
    check("the draft is refused with no sample selected", verifyDraft(draft, message.id, String(b.runId), null) === null);
    check("a filed draft is not offered again", verifyDraft({ ...draft, filedDecisionId: 1 }, message.id, String(b.runId), gapB.id) === null);
    check("the thread was written and read back with the run key", (await db.select().from(schema.assistantThreads).where(eq(schema.assistantThreads.id, threadId)))[0]?.runId === String(b.runId));
  }
}

main()
  .then(async () => {
    await cleanup();
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed.`);
      process.exit(1);
    }
    console.log("\nAll assistant checks passed.");
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => undefined);
    await sql.end().catch(() => undefined);
    process.exit(1);
  });

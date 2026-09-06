/**
 * The closed catalog: ten tools, each a JSON schema the model sees, a kind
 * that says what it may do, and a handler that is plain code. No table or
 * column name is an argument anywhere here; nothing in this file or in
 * ./handlers.ts writes a row.
 *
 * start_run is the one action, and its handler here only proposes. The
 * function that creates a run is in ./start-run.ts and is called by the API
 * route from a human's click, never by the model.
 */
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import {
  compareRuns,
  draftNote,
  explainSample,
  exposureByCounterparty,
  listGaps,
  priorRulings,
  proposeRemedy,
  runSummary,
  startRunProposal,
  whereIs,
} from "./handlers";
import type { ToolArgs, ToolKind, ToolName, ToolResult } from "./types";

export type ToolDefinition = {
  name: ToolName;
  kind: ToolKind;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: ToolArgs) => Promise<ToolResult> | ToolResult;
};

const RUN_ID = {
  type: "string",
  description: 'The run key: a number like "7", or "mock" for the walkthrough. Omit for the most recent run.',
};
const SAMPLE_REF = {
  type: "string",
  description: 'The sample reference exactly as shown on the run screen: "invoice:24", "bank:109", or "dodo:340".',
};

export const TOOLS: ToolDefinition[] = [
  {
    name: "run_summary",
    kind: "read",
    description:
      "How one audit run went: samples drawn, defended, gaps waiting on the controller, exceptions, coverage percent, resolved by memory, and the inputs it was started with.",
    parameters: { type: "object", properties: { runId: RUN_ID }, additionalProperties: false },
    handler: runSummary,
  },
  {
    name: "list_gaps",
    kind: "read",
    description:
      "The samples in a run the accountant could not defend, with the gap kind, amount, and counterparty. By default only those still waiting on a ruling.",
    parameters: {
      type: "object",
      properties: {
        runId: RUN_ID,
        kind: { type: "string", description: "Filter to one gap kind, e.g. rate_mismatch, duplicate_payment, missing_approval." },
        counterparty: { type: "string", description: "Filter to one vendor, bank counterparty, or Dodo type." },
        status: { type: "string", enum: ["unruled", "ruled", "all"], description: "unruled (default), ruled, or all." },
        limit: { type: "integer", description: "Maximum rows, default 10." },
      },
      additionalProperties: false,
    },
    handler: listGaps,
  },
  {
    name: "explain_sample",
    kind: "read",
    description:
      "Everything on file about one sample: the auditor and accountant thread, the gap, the evidence rows, the controller's last ruling, and the proposed adjusting entry.",
    parameters: {
      type: "object",
      properties: { sampleRef: SAMPLE_REF, runId: RUN_ID },
      required: ["sampleRef"],
      additionalProperties: false,
    },
    handler: explainSample,
  },
  {
    name: "exposure_by_counterparty",
    kind: "read",
    description:
      "Money at stake in a run, grouped by counterparty: the samples the accountant could not defend, summed, with how many are ruled exceptions and how many still wait on the controller.",
    parameters: {
      type: "object",
      properties: {
        runId: RUN_ID,
        counterparty: { type: "string", description: "Only this counterparty." },
        limit: { type: "integer", description: "Maximum groups, default 8." },
      },
      additionalProperties: false,
    },
    handler: exposureByCounterparty,
  },
  {
    name: "prior_rulings",
    kind: "read",
    description:
      "What the controller has already ruled on a counterparty across every run: learned rules and referee decisions, with notes, remedies, and whether memory can reuse them.",
    parameters: {
      type: "object",
      properties: {
        counterparty: { type: "string", description: "The vendor, bank counterparty, or Dodo type, exactly as named in the books." },
        limit: { type: "integer", description: "Maximum rows, default 10." },
      },
      required: ["counterparty"],
      additionalProperties: false,
    },
    handler: priorRulings,
  },
  {
    name: "compare_runs",
    kind: "read",
    description:
      "Coverage and gaps in one run against an earlier comparable run, and the items that recurred. With no ids, the two most recent comparable runs.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "The later run. Omit for the latest." },
        previousRunId: { type: "string", description: "The earlier run. Omit to find the most recent comparable one." },
      },
      additionalProperties: false,
    },
    handler: compareRuns,
  },
  {
    name: "where_is",
    kind: "read",
    description:
      "Turns a reference into a link: a sample like invoice:24, a bare row id, part of a sample label, a run name, or the binder for a run.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to find." },
        runId: RUN_ID,
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: whereIs,
  },
  {
    name: "draft_note",
    kind: "draft",
    description:
      "Drafts the controller's note for one verdict on one sample. Writes nothing; the controller edits and files it.",
    parameters: {
      type: "object",
      properties: {
        sampleRef: SAMPLE_REF,
        verdict: { type: "string", enum: ["needs_more", "accepted_with_note", "exception"] },
        runId: RUN_ID,
      },
      required: ["sampleRef", "verdict"],
      additionalProperties: false,
    },
    handler: draftNote,
  },
  {
    name: "propose_remedy",
    kind: "draft",
    description:
      "Proposes the remedy and adjusting entry for an exception on one sample, from a fixed table by gap kind. Writes nothing.",
    parameters: {
      type: "object",
      properties: { sampleRef: SAMPLE_REF, runId: RUN_ID },
      required: ["sampleRef"],
      additionalProperties: false,
    },
    handler: proposeRemedy,
  },
  {
    name: "start_run",
    kind: "action",
    description:
      "Proposes a new audit run with these parameters. The run starts only after the controller confirms with a click.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        seed: { type: "integer" },
        materiality: { type: "number", description: "In dollars." },
        sampleSize: { type: "integer" },
        cycles: {
          type: "array",
          items: { type: "string", enum: ["purchases", "cash", "revenue", "payroll"] },
        },
      },
      additionalProperties: false,
    },
    handler: startRunProposal,
  },
];

export const TOOL_BY_NAME: Record<ToolName, ToolDefinition> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t]),
) as Record<ToolName, ToolDefinition>;

/** The schemas as the OpenAI-compatible endpoint takes them. */
export const TOOL_SCHEMAS: ChatCompletionFunctionTool[] = TOOLS.map((t) => ({
  type: "function",
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

export async function runTool(name: ToolName, args: ToolArgs): Promise<ToolResult> {
  return TOOL_BY_NAME[name].handler(args);
}

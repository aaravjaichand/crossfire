/**
 * Shared vocabulary for the controller's assistant. Pure types and constants:
 * this file is imported by the schema, the handlers, the route, and the client
 * components, so it must not pull in the database or React.
 */
import type { Citation } from "@/lib/accountant/types";
import type { ProposedEntry } from "@/lib/referee/adjustments";
import type { Remedy, Verdict } from "@/lib/referee/verdicts";

export const TOOL_NAMES = [
  "run_summary",
  "list_gaps",
  "explain_sample",
  "exposure_by_counterparty",
  "prior_rulings",
  "compare_runs",
  "where_is",
  "draft_note",
  "propose_remedy",
  "start_run",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * read   reads the books and the runs, writes nothing.
 * draft  produces text or a pre-selection for the human, writes nothing.
 * action writes. Only start_run, and only after a human confirms with a click.
 */
export type ToolKind = "read" | "draft" | "action";

export type ToolArgs = Record<string, unknown>;

export type AssistantToolCall = { name: ToolName; args: ToolArgs };

export type ToolRow = Record<string, unknown>;

/** What every handler returns. `rows` is what the model reads and what the
 * table renders when the model's prose is rejected. */
export type ToolResult = {
  rows: ToolRow[];
  citations: Citation[];
  /** A deterministic remark about the result: refused, empty, truncated. */
  note?: string;
  /** What `runId` resolved to, echoed on every run-scoped result. */
  resolvedRunId?: string;
  /** Set by draft_note, propose_remedy, and start_run. */
  draft?: AssistantDraft;
};

/** A tool call as it is persisted beside the answer it fed. */
export type AssistantToolResult = AssistantToolCall &
  Omit<ToolResult, "draft"> & {
    /** A handler that threw. The message is written for the controller. */
    error?: string;
    /** Wall-clock for the handler, for the check suite's report. */
    ms?: number;
  };

/** The verdicts a note can be drafted for. sufficient carries no note. */
export type DraftVerdict = Extract<Verdict, "needs_more" | "accepted_with_note" | "exception">;

export const DRAFT_VERDICTS: DraftVerdict[] = ["needs_more", "accepted_with_note", "exception"];

export function isDraftVerdict(value: unknown): value is DraftVerdict {
  return typeof value === "string" && (DRAFT_VERDICTS as string[]).includes(value);
}

/**
 * A draft is text or a pre-selection for a human. It carries the run and the
 * sample it was written about so the run screen and the filing action can
 * refuse to apply it anywhere else. `filedDecisionId` is set only after a
 * human clicked "File as …" and the referee action recorded the ruling.
 */
export type RulingDraft = {
  kind: "note" | "remedy";
  verdict: DraftVerdict;
  /** The drafted note. Empty for a remedy-only draft. */
  text: string;
  /** Pre-selected remedy, for an exception. */
  remedy?: Remedy;
  /** The proposed adjusting entry the remedy goes with. */
  entry?: ProposedEntry;
  citations: Citation[];
  runId: string;
  sampleRef: string;
  /** Where the text came from, when it was drafted by the model or assembled. */
  source: "model" | "fallback";
  filedDecisionId?: number;
};

/** The parameters of a run the assistant proposes. Nothing is written until a
 * human clicks "Start run", which calls the engine with exactly these. */
export type StartRunDraft = {
  kind: "start_run";
  params: {
    name: string;
    seed: number;
    /** In cents, as audit_runs.materiality holds it. */
    materiality: number;
    sampleSize: number;
    cycles: string[];
  };
  /** Set once the human confirmed and the run was created. */
  startedRunId?: number;
  startedSampleCount?: number;
};

export type AssistantDraft = RulingDraft | StartRunDraft;

/** The closed set of openings a run-screen chip can ask for. Never free text. */
export const CHIP_ASKS = ["explain_gap", "draft_accept", "prior_rulings"] as const;
export type ChipAsk = (typeof CHIP_ASKS)[number];

export function isChipAsk(value: unknown): value is ChipAsk {
  return typeof value === "string" && (CHIP_ASKS as readonly string[]).includes(value);
}

export type AssistantMessageView = {
  id: number;
  threadId: number;
  turn: number;
  role: "user" | "assistant";
  content: string;
  toolCalls: AssistantToolCall[];
  toolResults: AssistantToolResult[];
  citations: Citation[];
  draft?: AssistantDraft;
  runId?: string;
  sampleRef?: string;
  answerSource?: { source: "model" | "fallback"; reason?: string };
  createdAt: string;
};

export type AssistantThreadView = {
  id: number;
  title: string;
  runId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

/** POST /api/assistant. */
export type AssistantRequest = {
  threadId?: number;
  /** ≤ 2000 characters. */
  message: string;
  runId?: string;
  sampleRef?: string;
  /** Only from a suggestion chip, which already knows its tool. */
  forceTool?: ToolName;
  /** Only from the "Start run" button on a start_run draft: the message id
   * whose persisted parameters the human is confirming. */
  confirmStartRun?: number;
};

export type AssistantResponse =
  | {
      ok: true;
      threadId: number;
      message: AssistantMessageView;
      resolvedRunId: string;
    }
  | { ok: false; message: string };

export const MAX_MESSAGE_CHARS = 2000;

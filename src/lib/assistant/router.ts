/**
 * Fallback 1: a keyword table that picks one tool for a question when native
 * tool calling is unavailable — a 4xx/5xx, a timeout, malformed tool_calls,
 * or the model turned off. It is also what makes assistant:check runnable
 * with the model off, which is why it is cut last.
 *
 * Order matters: the first pattern that matches wins, so the more specific
 * intents (a sample reference, a draft, a comparison) come before the general
 * ones (gaps, summary). Arguments a regex can reach are extracted here;
 * anything else is left to the JSON-mode extraction in loop.ts, or to the
 * tool's own defaults.
 */
import { isDraftVerdict, type ToolArgs, type ToolName } from "./types";

export type RouterContext = { runId?: string; sampleRef?: string };

export type Route = { tool: ToolName; args: ToolArgs };

type Rule = {
  pattern: RegExp;
  tool: ToolName;
  extract?: (match: RegExpMatchArray, text: string) => ToolArgs;
};

const SAMPLE_REF = /\b(invoice|bank|dodo)\s*[:#]\s*(\d+)\b/i;
const RUN_NUMBER = /\brun\s*#?\s*(\d+)\b/i;
// "for Stratus Compute", "to Meridian Freight", "on Stratus Compute before".
// A run of capitalised words after a preposition, stopping at the first
// lowercase word.
const COUNTERPARTY = /\b(?:for|to|on|about|with|against|from)\s+((?:[A-Z][\w&.'-]*)(?:\s+[A-Z][\w&.'-]*)*)/;
const CYCLES = ["purchases", "cash", "revenue", "payroll"];

export function extractSampleRef(text: string): string | undefined {
  const m = text.match(SAMPLE_REF);
  return m ? `${m[1].toLowerCase()}:${m[2]}` : undefined;
}

export function extractRunId(text: string): string | undefined {
  if (/\b(walkthrough|mock run)\b/i.test(text)) return "mock";
  const m = text.match(RUN_NUMBER);
  return m ? m[1] : undefined;
}

export function extractCounterparty(text: string): string | undefined {
  const m = text.replace(/[?.!]+$/, "").match(COUNTERPARTY);
  if (!m) return undefined;
  // "for Stratus Compute in run 7" — stop at a run reference.
  return m[1].replace(/\s+(In|Run|Before|Yet|Now)$/i, "").trim() || undefined;
}

export function extractVerdict(text: string): string | undefined {
  const t = text.toLowerCase();
  if (/accept(?:ed)?[\s-]+with[\s-]+note|accept/.test(t)) return "accepted_with_note";
  if (/needs?[\s-]+more|send (?:it )?back|look again/.test(t)) return "needs_more";
  if (/exception|finding/.test(t)) return "exception";
  return undefined;
}

export function extractGapKind(text: string): string | undefined {
  const t = text.toLowerCase();
  const kinds: [RegExp, string][] = [
    [/rate[\s-]*mismatch|over ?bill|above (?:the )?contract/, "rate_mismatch"],
    [/duplicate[\s-]*payment|paid twice/, "duplicate_payment"],
    [/duplicate[\s-]*invoice/, "duplicate_invoice_month"],
    [/missing[\s-]*approval|unapproved|no approval/, "missing_approval"],
    [/missing[\s-]*ledger|not in the ledger|unrecorded/, "missing_ledger_entry"],
    [/no[\s-]*bank[\s-]*match|unpaid|no payment/, "no_bank_match"],
    [/unknown[\s-]*counterparty|no contract/, "unknown_counterparty"],
    [/outside[\s-]*(?:the )?contract/, "outside_contract_term"],
    [/payout[\s-]*mismatch|payout/, "payout_mismatch"],
    [/no[\s-]*(?:matching[\s-]*)?invoice/, "no_matching_invoice"],
  ];
  for (const [re, kind] of kinds) if (re.test(t)) return kind;
  return undefined;
}

function startRunArgs(text: string): ToolArgs {
  const args: ToolArgs = {};
  const seed = text.match(/\bseed\s*(?:of\s*)?#?(\d+)/i);
  if (seed) args.seed = Number(seed[1]);
  const samples = text.match(/(\d+)\s*samples?\b/i) ?? text.match(/\bsample\s*size\s*(?:of\s*)?(\d+)/i);
  if (samples) args.sampleSize = Number(samples[1]);
  const materiality = text.match(/materiality\s*(?:of|at)?\s*\$?\s*([\d,]+(?:\.\d+)?)/i) ?? text.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (materiality) args.materiality = Number(materiality[1].replace(/,/g, ""));
  const cycles = CYCLES.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
  if (cycles.length > 0) args.cycles = cycles;
  const name = text.match(/(?:named|called|name)\s+["“']([^"”']+)["”']/i);
  if (name) args.name = name[1];
  return args;
}

const RULES: Rule[] = [
  {
    pattern: /\b(start|kick off|launch|create|begin)\b.*\brun\b|\bnew run\b/i,
    tool: "start_run",
    extract: (_m, text) => startRunArgs(text),
  },
  {
    pattern: /\b(draft|write|prepare)\b/i,
    tool: "draft_note",
    extract: (_m, text) => ({
      sampleRef: extractSampleRef(text),
      verdict: extractVerdict(text),
      runId: extractRunId(text),
    }),
  },
  {
    pattern: /\b(remedy|remediat|adjusting entry|journal entry)\b/i,
    tool: "propose_remedy",
    extract: (_m, text) => ({ sampleRef: extractSampleRef(text), runId: extractRunId(text) }),
  },
  {
    pattern: /\b(compare|comparison|improv\w*|better|worse|last two|previous run|earlier run|since the last|trend|progress)\b/i,
    tool: "compare_runs",
    extract: (_m, text) => {
      const ids = [...text.matchAll(/\brun\s*#?\s*(\d+)/gi)].map((m) => m[1]);
      return ids.length >= 2 ? { previousRunId: ids[0], runId: ids[1] } : ids.length === 1 ? { runId: ids[0] } : {};
    },
  },
  {
    pattern: /\b(exposure|exposed|at stake|at risk|biggest|largest|most money|owed)\b/i,
    tool: "exposure_by_counterparty",
    extract: (_m, text) => ({ runId: extractRunId(text), counterparty: extractCounterparty(text) }),
  },
  {
    pattern: /\b(rule|ruled|ruling|rulings|decide|decided|decision|decisions|prior|previously|before|history)\b/i,
    tool: "prior_rulings",
    extract: (_m, text) => ({ counterparty: extractCounterparty(text) }),
  },
  {
    pattern: SAMPLE_REF,
    tool: "explain_sample",
    extract: (_m, text) => ({ sampleRef: extractSampleRef(text), runId: extractRunId(text) }),
  },
  {
    pattern: /\b(open|binder|where is|where's|link|take me|go to|find|show me the run)\b/i,
    tool: "where_is",
    extract: (_m, text) => ({
      query: /\bbinder\b/i.test(text)
        ? "binder"
        : text
            .replace(/^(open|where is|where's|find|link to|take me to|go to|show me)\s+/i, "")
            .replace(/\b(the|in|for)\s+run\s*#?\d+\b/i, "")
            .replace(/[?.!]+$/, "")
            .trim(),
      runId: extractRunId(text),
    }),
  },
  {
    pattern: /\b(gap|gaps|waiting|outstanding|queue|needs? ruling|unruled|still|pending|left|to do|todo)\b/i,
    tool: "list_gaps",
    extract: (_m, text) => ({
      runId: extractRunId(text),
      kind: extractGapKind(text),
      counterparty: extractCounterparty(text),
    }),
  },
  {
    pattern: /\b(how did|how's|how is|how was|summary|summarise|summarize|went|coverage|status|overview|last run|latest run)\b/i,
    tool: "run_summary",
    extract: (_m, text) => ({ runId: extractRunId(text) }),
  },
];

/**
 * Picks one tool for the question. Never returns nothing: a question that
 * matches no rule is answered with the run summary, which is the safest
 * default a controller can be handed.
 */
export function route(text: string, context: RouterContext = {}): Route {
  const trimmed = text.trim();
  for (const rule of RULES) {
    const m = trimmed.match(rule.pattern);
    if (!m) continue;
    const args = rule.extract ? rule.extract(m, trimmed) : {};
    return { tool: rule.tool, args: withContext(rule.tool, args, context) };
  }
  return { tool: "run_summary", args: withContext("run_summary", {}, context) };
}

/** Arguments for a tool the caller already chose (a suggestion chip). */
export function argsFor(tool: ToolName, text: string, context: RouterContext = {}): ToolArgs {
  const rule = RULES.find((r) => r.tool === tool);
  const m = rule ? text.match(rule.pattern) : null;
  const args = rule?.extract ? rule.extract(m ?? ([""] as unknown as RegExpMatchArray), text) : {};
  return withContext(tool, args, context);
}

function withContext(tool: ToolName, args: ToolArgs, context: RouterContext): ToolArgs {
  const out: ToolArgs = {};
  for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== "") out[k] = v;
  if (out.runId === undefined && context.runId && tool !== "prior_rulings" && tool !== "start_run") out.runId = context.runId;
  if (out.sampleRef === undefined && context.sampleRef && (tool === "explain_sample" || tool === "draft_note" || tool === "propose_remedy")) {
    out.sampleRef = context.sampleRef;
  }
  if (tool === "draft_note" && !isDraftVerdict(out.verdict)) delete out.verdict;
  return out;
}

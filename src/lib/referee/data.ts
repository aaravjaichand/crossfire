import type { EvidenceBundle, Gap, SampleType } from "./evidence-types";
import { buildMockRun, MOCK_RUN_ID } from "./mock-run";
import { buildRealRun } from "./real-run";
import { loadDecisions, type StoredDecision } from "./decisions";
import { REMEDY_LABEL, STATUS_AFTER } from "./verdicts";

export { formatSampleId, parseSampleId } from "./sample-id";
export { MOCK_RUN_ID } from "./mock-run";
export { formatMoney } from "./format";

export type SampleStatus = "open" | "defended" | "gap" | "conceded";

export type MessageRole = "auditor" | "accountant" | "referee";

export type MessageView = {
  turn: number;
  role: MessageRole;
  content: string;
  evidence?: EvidenceBundle;
  /** The audit procedure the question came from. Set on auditor turns only. */
  procedure?: string;
};

/** The last ruling on a sample, or undefined when the controller has not ruled. */
export type Ruling = StoredDecision;

export type SampleView = {
  /** "invoice:5" — the underlying source row. URLs and referee_decisions use this. */
  id: string;
  /** audit_samples.id, the conversation row. Real runs only; never in a URL. */
  auditSampleId?: number;
  type: SampleType;
  label: string;
  amount: string;
  date: string;
  status: SampleStatus;
  thread: MessageView[];
  /** The most recent controller ruling. Drives the "ruled" marker in the list. */
  ruling?: Ruling;
};

export type RunView = {
  /** The run key decisions are filed under: an audit_runs id as a string, or "mock". */
  id: string;
  name: string;
  kind: "mock" | "real";
  samples: SampleView[];
  /**
   * The engine's columns on audit_runs. Undefined for the mock run, which has
   * no such row — the header renders an em dash in their place.
   */
  materiality?: number;
  sampleSize?: number;
  cycles?: string[];
  /** running | complete | failed. Drives the progress poll on the run screen. */
  status?: string;
  /** Samples the engine has settled so far, against sampleCount. */
  progress?: number;
  /** Samples actually drawn; materiality can push this past sampleSize. */
  sampleCount?: number;
};


export function coverage(run: RunView): { defended: number; total: number; percent: number } {
  const total = run.samples.length;
  const defended = run.samples.filter((s) => s.status === "defended").length;
  const percent = total === 0 ? 0 : Math.round((defended / total) * 100);
  return { defended, total, percent };
}

/**
 * Everything the left pane and the coverage ring are derived from, in one
 * short string. The thread poll returns it so the client can tell when the
 * rest of the page has gone stale and needs a refresh, not just the open
 * thread it is watching.
 */
export function runVersion(run: RunView): string {
  return run.samples.map((s) => `${s.id}:${s.status}:${s.thread.length}`).join("|");
}

/**
 * A numeric run id addresses a real audit_runs row and nothing else. Anything
 * else is the mock run, which always files its decisions under "mock" whatever
 * path was used to reach it, so a mock decision can never be inherited by a
 * real run that is created with that id later.
 */
export function resolveRunId(runId: string): { kind: "real"; id: number } | { kind: "mock" } {
  if (/^\d+$/.test(runId)) {
    const id = Number(runId);
    if (Number.isSafeInteger(id) && id > 0) return { kind: "real", id };
  }
  return { kind: "mock" };
}

/** null means the caller asked for a real run id that does not exist. */
export async function getRun(runId: string): Promise<RunView | null> {
  const resolved = resolveRunId(runId);
  const run =
    resolved.kind === "real" ? await buildRealRun(resolved.id) : await buildMockRun(MOCK_RUN_ID);
  if (!run) return null;

  const decisions = await loadDecisions(run.id);
  return {
    ...run,
    samples: run.samples.map((s) => applyDecisions(run.kind, s, decisions.get(s.id))),
  };
}

export async function getSample(runId: string, sampleId: string): Promise<SampleView | null> {
  const run = await getRun(runId);
  if (!run) return null;
  return run.samples.find((s) => s.id === sampleId) ?? null;
}

/**
 * Referee turns are appended to the thread for both kinds of run, and the last
 * ruling is hung on the sample so the list can mark it. The status differs: a
 * real run carries it on audit_samples.status, written in the same transaction
 * as the decision, so that column stays authoritative. The mock run has no such
 * row, so its status is derived from the decisions themselves.
 */
function applyDecisions(
  kind: RunView["kind"],
  sample: SampleView,
  decisions: StoredDecision[] | undefined,
): SampleView {
  if (!decisions || decisions.length === 0) return sample;
  const thread = [...sample.thread];
  for (const d of decisions) {
    thread.push({ turn: thread.length + 1, role: "referee", content: refereeLine(d) });
  }
  const last = decisions[decisions.length - 1];
  if (kind === "real") return { ...sample, thread, ruling: last };
  return { ...sample, status: STATUS_AFTER[last.verdict], thread, ruling: last };
}

function refereeLine(d: StoredDecision): string {
  switch (d.verdict) {
    case "sufficient":
      return "Sufficient. The evidence supports the balance as filed.";
    case "needs_more":
      return d.note ? `Needs more: ${d.note}` : "Needs more. Search again.";
    case "exception": {
      const remedy = d.remedy ? REMEDY_LABEL[d.remedy].toLowerCase() : "no remedy recorded";
      const head = `Exception. Remedy: ${remedy}.`;
      return d.note ? `${head} ${d.note}` : head;
    }
    case "accepted_with_note":
      return d.note
        ? `Accepted with note: ${d.note}`
        : "Accepted with note. Recorded below the threshold worth pursuing.";
  }
}

/**
 * The bundle the exception panel and the learned rule are both derived from:
 * the most recent accountant turn that carried evidence.
 */
export function latestEvidence(sample: SampleView): EvidenceBundle | undefined {
  return [...sample.thread].reverse().find((m) => m.role === "accountant" && m.evidence)?.evidence;
}

/**
 * The gap an exception is being recorded against. Defaulting to "other" rather
 * than returning nothing is what guarantees every exception has a proposed
 * entry, including one raised on a sample the accountant thought it had
 * defended.
 */
export function primaryGap(sample: SampleView): Gap {
  const gap = latestEvidence(sample)?.gaps[0];
  return gap ?? { kind: "other", description: "" };
}

/**
 * Vendor name, bank counterparty, or Dodo transaction type, for the learned
 * rule. Every label in labels.ts leads with exactly this, so it is read back
 * off the label rather than re-queried per ruling.
 */
export function counterpartyOf(sample: SampleView): string {
  const head = sample.label.split(" · ")[0]?.trim() ?? "";
  if (sample.type === "dodo_transaction") return head.replace(/^Dodo\s+/, "") || "dodo";
  return head || sample.type;
}

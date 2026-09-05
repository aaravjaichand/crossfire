import type { EvidenceBundle, SampleType } from "./evidence-types";
import { buildMockRun, MOCK_RUN_ID } from "./mock-run";
import { buildRealRun } from "./real-run";
import { loadDecisions, type StoredDecision } from "./decisions";

export { formatSampleId, parseSampleId } from "./sample-id";
export { MOCK_RUN_ID } from "./mock-run";

export type SampleStatus = "open" | "defended" | "gap" | "conceded";

export type MessageRole = "auditor" | "accountant" | "referee";

export type MessageView = {
  turn: number;
  role: MessageRole;
  content: string;
  evidence?: EvidenceBundle;
};

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
};

export type RunView = {
  /** The run key decisions are filed under: an audit_runs id as a string, or "mock". */
  id: string;
  name: string;
  kind: "mock" | "real";
  samples: SampleView[];
};

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatMoney(value: string | number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n < 0 ? `-${MONEY.format(Math.abs(n))}` : MONEY.format(n);
}

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

const STATUS_AFTER: Record<StoredDecision["decision"], SampleStatus> = {
  approve: "defended",
  concede: "conceded",
  redirect: "open",
};

/**
 * Referee turns are appended to the thread for both kinds of run. The status
 * differs: a real run carries it on audit_samples.status, written in the same
 * transaction as the decision, so that column stays authoritative. The mock
 * run has no such row, so its status is derived from the decisions themselves.
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
  if (kind === "real") return { ...sample, thread };
  const last = decisions[decisions.length - 1];
  return { ...sample, status: STATUS_AFTER[last.decision], thread };
}

function refereeLine(d: StoredDecision): string {
  if (d.decision === "approve") return "Approved. The defense stands as filed.";
  if (d.decision === "concede") return "Conceded. Recorded as an unresolved finding for the fix list.";
  return d.note ? `Redirected: ${d.note}` : "Redirected. Search again.";
}

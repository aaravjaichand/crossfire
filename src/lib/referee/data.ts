import type { EvidenceBundle, SampleType } from "./evidence-types";
import { buildMockRun } from "./mock-run";
import { getDecisions, type StoredDecision } from "./decisions";

export { formatSampleId, parseSampleId } from "./sample-id";

export type SampleStatus = "open" | "defended" | "gap" | "conceded";

export type MessageRole = "auditor" | "accountant" | "referee";

export type MessageView = {
  turn: number;
  role: MessageRole;
  content: string;
  evidence?: EvidenceBundle;
};

export type SampleView = {
  id: string; // "invoice:5"
  type: SampleType;
  label: string;
  amount: string;
  date: string;
  status: SampleStatus;
  thread: MessageView[];
};

export type RunView = {
  id: string;
  name: string;
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

// Every unknown run id falls back to the mock run. Swapping in Worker B's
// audit_runs / audit_samples / audit_exchanges tables means replacing the body
// of this function; nothing else in the UI reads the database.
export async function getRun(runId: string): Promise<RunView> {
  const run = await buildMockRun(runId);
  const decisions = await getDecisions(runId);
  return { ...run, samples: run.samples.map((s) => applyDecisions(s, decisions.get(s.id))) };
}

export async function getSample(runId: string, sampleId: string): Promise<SampleView | null> {
  const run = await getRun(runId);
  return run.samples.find((s) => s.id === sampleId) ?? null;
}

const STATUS_AFTER: Record<StoredDecision["decision"], SampleStatus> = {
  approve: "defended",
  concede: "conceded",
  redirect: "open",
};

function applyDecisions(sample: SampleView, decisions: StoredDecision[] | undefined): SampleView {
  if (!decisions || decisions.length === 0) return sample;
  const thread = [...sample.thread];
  for (const d of decisions) {
    thread.push({
      turn: thread.length + 1,
      role: "referee",
      content: refereeLine(d),
    });
  }
  const last = decisions[decisions.length - 1];
  return { ...sample, status: STATUS_AFTER[last.decision], thread };
}

function refereeLine(d: StoredDecision): string {
  if (d.decision === "approve") return "Approved. The defense stands as filed.";
  if (d.decision === "concede") return "Conceded. Recorded as an unresolved finding for the fix list.";
  return d.note ? `Redirected: ${d.note}` : "Redirected. Search again.";
}

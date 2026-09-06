import type { AuditProcedure } from "@/lib/auditor/questions";
import type { SampleStatus } from "@/lib/referee/data";
import type { Verdict } from "@/lib/referee/verdicts";

// Audit tickmarks. Shape carries the status, so nothing depends on hue.
export const STATUS_META: Record<
  SampleStatus,
  { label: string; mark: string; text: string; hint: string }
> = {
  open: { label: "Open", mark: "○", text: "text-ink-3", hint: "With the accountant" },
  defended: { label: "Defended", mark: "✓", text: "text-accent", hint: "Evidence accepted" },
  gap: { label: "Gap", mark: "△", text: "text-warning", hint: "Accountant admitted a gap" },
  // No verdict produces this any more; it is what the pre-verdict "concede"
  // decision left behind, and rows carrying it still have to render.
  conceded: { label: "Conceded", mark: "✕", text: "text-danger", hint: "Finding recorded in an earlier run" },
};

/**
 * A sample settled by a controller ruling from an earlier run
 * (audit_samples.resolution = "memory"). It is defended — it counts towards
 * coverage like any other defended sample — but it was not the evidence in
 * this run's thread that closed it, and an auditor reading the list should be
 * able to see which is which at a glance. Its own shape, for the same reason
 * every other status has one.
 */
export const MEMORY_MARK = "◆";

export const MEMORY_META = {
  label: "Resolved by memory",
  mark: MEMORY_MARK,
  text: "text-accent",
  hint: "Closed by the controller's ruling on an earlier run",
};

// Shown on a sample the controller has already ruled on. An exception leaves
// the status at "gap", so without this the list cannot tell a gap that is
// waiting for a ruling from one that has had it.
export const VERDICT_MARK: Record<Verdict, { short: string; text: string }> = {
  sufficient: { short: "Sufficient", text: "text-accent" },
  needs_more: { short: "Needs more", text: "text-ink-2" },
  exception: { short: "Exception", text: "text-danger" },
  accepted_with_note: { short: "Accepted", text: "text-accent" },
};

export const TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice",
  bank_transaction: "Bank",
  dodo_transaction: "Dodo",
};

// The engine stores the procedure id; a controller should read the name of the
// procedure, not its slug. Typed against AuditProcedure on purpose: adding a
// procedure without a label here is a build error rather than a raw
// "three_way_match" appearing on screen.
export const PROCEDURE_LABEL: Record<AuditProcedure, string> = {
  three_way_match: "Three-way match",
  cutoff: "Cutoff",
  unrecorded_liabilities: "Unrecorded liabilities",
  bank_rec: "Bank reconciliation",
  revenue_tie_out: "Revenue tie-out",
  approval_control: "Approval control",
};

export function procedureLabel(id: string): string {
  return PROCEDURE_LABEL[id as AuditProcedure] ?? id;
}

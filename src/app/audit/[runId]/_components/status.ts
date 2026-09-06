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

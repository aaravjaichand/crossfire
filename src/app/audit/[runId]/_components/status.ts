import type { SampleStatus } from "@/lib/referee/data";

// Audit tickmarks. Shape carries the status, so nothing depends on hue.
export const STATUS_META: Record<
  SampleStatus,
  { label: string; mark: string; text: string; hint: string }
> = {
  open: { label: "Open", mark: "○", text: "text-ink-3", hint: "Awaiting the referee" },
  defended: { label: "Defended", mark: "✓", text: "text-accent", hint: "Evidence accepted" },
  gap: { label: "Gap", mark: "△", text: "text-warning", hint: "Accountant admitted a gap" },
  conceded: { label: "Conceded", mark: "✕", text: "text-danger", hint: "Referee recorded a finding" },
};

export const TYPE_LABEL: Record<string, string> = {
  invoice: "Invoice",
  bank_transaction: "Bank",
  dodo_transaction: "Dodo",
};

import type { SampleStatus } from "@/lib/referee/data";

// Four muted dot colors, each paired with the text label that carries the same
// meaning for anyone who cannot separate them by hue.
export const STATUS_META: Record<
  SampleStatus,
  { label: string; dot: string; text: string; hint: string }
> = {
  open: {
    label: "Open",
    dot: "bg-slate-400/80",
    text: "text-slate-300",
    hint: "Awaiting the referee",
  },
  defended: {
    label: "Defended",
    dot: "bg-emerald-500/80",
    text: "text-emerald-300",
    hint: "Evidence accepted",
  },
  gap: {
    label: "Gap",
    dot: "bg-amber-500/80",
    text: "text-amber-300",
    hint: "Accountant admitted a gap",
  },
  conceded: {
    label: "Conceded",
    dot: "bg-rose-500/70",
    text: "text-rose-300",
    hint: "Referee recorded a finding",
  },
};

export const TYPE_LABEL: Record<string, string> = {
  invoice: "INV",
  bank_transaction: "BANK",
  dodo_transaction: "DODO",
};

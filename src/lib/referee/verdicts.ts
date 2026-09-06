// The controller's four verdicts, and what each one requires and implies.
//
// This module is deliberately free of database and React imports so the
// vocabulary is shared by decide.ts, the server actions, the checks, and the
// client controls without any of them pulling in the others.

import type { SampleStatus } from "./data";

export type Verdict = "sufficient" | "needs_more" | "exception" | "accepted_with_note";

export type Remedy = "recover_cash" | "post_entry" | "fix_control" | "investigate";

export const VERDICTS: Verdict[] = [
  "sufficient",
  "needs_more",
  "exception",
  "accepted_with_note",
];

export const REMEDIES: Remedy[] = ["recover_cash", "post_entry", "fix_control", "investigate"];

export const VERDICT_LABEL: Record<Verdict, string> = {
  sufficient: "Sufficient",
  needs_more: "Needs more",
  exception: "Exception",
  accepted_with_note: "Accept with note",
};

export const VERDICT_HINT: Record<Verdict, string> = {
  sufficient: "The evidence supports the balance. Nothing further is required.",
  needs_more: "Send the accountant back with a note saying where to look.",
  exception: "A real misstatement or control failure. Pick the remedy.",
  accepted_with_note: "Below the threshold worth pursuing, but worth recording.",
};

export const REMEDY_LABEL: Record<Remedy, string> = {
  recover_cash: "Recover cash",
  post_entry: "Post entry",
  fix_control: "Fix control",
  investigate: "Investigate",
};

export const REMEDY_HINT: Record<Remedy, string> = {
  recover_cash: "Chase the counterparty for a refund or credit note.",
  post_entry: "Book the proposed adjusting entry this period.",
  fix_control: "The money is right; the control that should have caught it is not.",
  investigate: "Not yet understood. Open a follow-up before the books close.",
};

/**
 * sufficient and accepted_with_note both settle the sample as defended: the
 * controller has accepted the position, with or without a caveat on file.
 * needs_more returns it to the engine, which re-runs the accountant against
 * audit_samples.pending_follow_up. exception is the only verdict that records
 * a finding.
 */
export const STATUS_AFTER: Record<Verdict, SampleStatus> = {
  sufficient: "defended",
  needs_more: "open",
  exception: "gap",
  accepted_with_note: "defended",
};

/** needs_more and accepted_with_note are refused without one. */
export const REQUIRES_NOTE: Record<Verdict, boolean> = {
  sufficient: false,
  needs_more: true,
  exception: false,
  accepted_with_note: true,
};

/** Only an exception carries one, and it is refused without one. */
export const REQUIRES_REMEDY: Record<Verdict, boolean> = {
  sufficient: false,
  needs_more: false,
  exception: true,
  accepted_with_note: false,
};

/**
 * A sufficient verdict teaches the accountant nothing it did not already do,
 * so it writes no learned_rules row. The other three all carry judgement:
 * where to look next, what the controller decided to live with, and what it
 * would not.
 */
export function teaches(verdict: Verdict): boolean {
  return verdict !== "sufficient";
}

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as string[]).includes(value);
}

export function isRemedy(value: unknown): value is Remedy {
  return typeof value === "string" && (REMEDIES as string[]).includes(value);
}

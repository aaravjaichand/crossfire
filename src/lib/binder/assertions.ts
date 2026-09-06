// What each audit procedure is testing, in the language a workpaper uses.
//
// A binder that says "three_way_match" tells a reviewer which code path ran.
// A binder that says "Occurrence and accuracy" tells them which assertion the
// evidence is supposed to support, which is what a reviewer is actually
// signing off on. Typed against AuditProcedure so adding a procedure without
// naming its assertion is a build error, not a blank cell.
import type { AuditProcedure } from "@/lib/auditor/questions";

export const ASSERTION: Record<AuditProcedure, string> = {
  three_way_match: "Occurrence and accuracy — the expense happened, at the agreed price",
  cutoff: "Cutoff — the item is recorded in the period it belongs to",
  unrecorded_liabilities: "Completeness — nothing owed at year end is missing from the books",
  bank_rec: "Existence — the cash movement is real and settled",
  revenue_tie_out: "Occurrence and accuracy of revenue — the processor's cash agrees to the ledger",
  approval_control: "Authorization — the disbursement was approved before it was paid",
};

export const PROCEDURE_NAME: Record<AuditProcedure, string> = {
  three_way_match: "Three-way match",
  cutoff: "Cutoff",
  unrecorded_liabilities: "Unrecorded liabilities",
  bank_rec: "Bank reconciliation",
  revenue_tie_out: "Revenue tie-out",
  approval_control: "Approval control",
};

export function assertionFor(procedure: string | null): string {
  if (!procedure) return "Not recorded";
  return ASSERTION[procedure as AuditProcedure] ?? "Not recorded";
}

export function procedureName(procedure: string | null): string {
  if (!procedure) return "Not recorded";
  return PROCEDURE_NAME[procedure as AuditProcedure] ?? procedure;
}

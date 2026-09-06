// Transaction cycles. A run is scoped to one or more of them, and every
// candidate belongs to exactly one, so selecting all four is a no-op over the
// candidate list (asserted in sampler.check.ts).
//
// The mapping is plain facts about the row, not a judgement:
//   purchases  invoices, and bank payments whose counterparty is a vendor
//   payroll    bank rows on the payroll account
//   revenue    Dodo Payments rows (customer payments, refunds, disputes, payouts)
//   cash       every other bank row: payout settlements, bank fees, interest,
//              and anything paid to a counterparty that is not a known vendor

export const CYCLES = ["purchases", "cash", "revenue", "payroll"] as const;

export type AuditCycle = (typeof CYCLES)[number];

export const PAYROLL_COUNTERPARTY = "Northwind Labs Payroll";

export function isAuditCycle(value: string): value is AuditCycle {
  return (CYCLES as readonly string[]).includes(value);
}

/**
 * Parses a caller-supplied cycle list (CLI flag, form field, jsonb column)
 * into a deduplicated list in canonical CYCLES order. An empty or fully
 * unrecognised list means "all cycles" rather than "no candidates", so a
 * missing input can never silently produce an empty run.
 */
export function parseCycles(input: readonly string[] | null | undefined): AuditCycle[] {
  if (!input || input.length === 0) return [...CYCLES];
  const wanted = new Set(
    input.map((c) => c.trim().toLowerCase()).filter((c): c is AuditCycle => isAuditCycle(c)),
  );
  if (wanted.size === 0) return [...CYCLES];
  return CYCLES.filter((c) => wanted.has(c));
}

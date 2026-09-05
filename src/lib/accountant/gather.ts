/**
 * Deterministic evidence gathering. No LLM, no randomness: given a sample id
 * the same rows come back every time, in the same order.
 *
 * Matching rules and the windows they use are stated in MATCHING below so the
 * referee can audit the accountant's search, not just its prose.
 */
import { and, eq, gte, inArray, like, lte, ne, or } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { db } from "../../db";
import {
  bankTransactions,
  contracts,
  dodoTransactions,
  invoices,
  ledgerEntries,
  vendors,
} from "../../db/schema";
import { addDays, dodoFeeCents, monthKey, monthOf, toCents, usd } from "./money";
import { formatSampleId } from "./sample";
import type { Citation, EvidenceBundle, Gap, GapKind, SampleRef } from "./types";

type Vendor = InferSelectModel<typeof vendors>;
type Invoice = InferSelectModel<typeof invoices>;
type Bank = InferSelectModel<typeof bankTransactions>;
type Dodo = InferSelectModel<typeof dodoTransactions>;

export const MATCHING = {
  /**
   * An invoice/bank pair matches on an exact reference (bank.reference =
   * invoices.invoice_number) or, when the bank line carries no invoice number,
   * on same vendor + same absolute amount with the bank date inside the
   * invoice's payment window: issue_date - 7 days .. due_date + 7 days.
   */
  paymentWindowDays: 7,
  /** Cash is reconciled against the bank feed within this many days of the sample. */
  cashScanWindowDays: 3,
  /** Internal policy: invoices above this need a named approver. */
  approvalThresholdCents: 1_000_000,
  /** Unknown counterparties above this are called out as the material case. */
  unknownCounterpartyNotableCents: 500_000,
} as const;

// Counterparties that are not vendors but are still known: the payroll account,
// the payment processor, and the company's own bank (fees and interest).
const PAYROLL_COUNTERPARTY = "Northwind Labs Payroll";
const DODO_COUNTERPARTY = "Dodo Payments";
const BANK_COUNTERPARTY = "Coastal Trust Bank";
const CASH_ACCOUNT = "Cash";

class Evidence {
  private readonly cites = new Map<string, Citation>();
  private readonly gapList: Gap[] = [];

  cite(c: Citation) {
    const key = `${c.table}#${c.id}:${c.field}`;
    if (!this.cites.has(key)) this.cites.set(key, c);
  }

  gap(kind: GapKind, description: string) {
    if (!this.gapList.some((g) => g.kind === kind && g.description === description)) {
      this.gapList.push({ kind, description });
    }
  }

  bundle(sample: SampleRef): EvidenceBundle {
    return { sample, citations: [...this.cites.values()], gaps: this.gapList };
  }
}

export async function gatherEvidence(sample: SampleRef): Promise<EvidenceBundle> {
  const ev = new Evidence();
  switch (sample.type) {
    case "invoice": {
      const invoice = await one(db.select().from(invoices).where(eq(invoices.id, sample.id)));
      requireRow(invoice, sample);
      await invoiceCore(ev, invoice);
      await linkPayments(ev, invoice);
      break;
    }
    case "bank_transaction": {
      const bank = await one(
        db.select().from(bankTransactions).where(eq(bankTransactions.id, sample.id)),
      );
      requireRow(bank, sample);
      await bankCore(ev, bank);
      break;
    }
    case "dodo_transaction": {
      const dodo = await one(
        db.select().from(dodoTransactions).where(eq(dodoTransactions.id, sample.id)),
      );
      requireRow(dodo, sample);
      await dodoCore(ev, dodo);
      break;
    }
  }
  return ev.bundle(sample);
}

// ---------- invoices ----------

/** Cites an invoice and every check that reads only the invoice, its vendor and its contract. */
async function invoiceCore(ev: Evidence, invoice: Invoice) {
  const amount = toCents(invoice.amount);
  ev.cite({
    table: "invoices",
    id: invoice.id,
    field: "amount",
    value: usd(amount),
    reason: `Invoice ${invoice.invoiceNumber} bills ${usd(amount)}.`,
    filePath: invoice.filePath,
  });
  ev.cite({
    table: "invoices",
    id: invoice.id,
    field: "invoice_number",
    value: invoice.invoiceNumber,
    reason: "Invoice number the bank payment and the ledger memo reference.",
    filePath: invoice.filePath,
  });
  ev.cite({
    table: "invoices",
    id: invoice.id,
    field: "issue_date",
    value: invoice.issueDate,
    reason: `Issued ${invoice.issueDate}, due ${invoice.dueDate} (net 30).`,
    filePath: invoice.filePath,
  });
  ev.cite({
    table: "invoices",
    id: invoice.id,
    field: "approved_by",
    value: invoice.approvedBy ?? "null",
    reason: invoice.approvedBy
      ? `Approved for payment by ${invoice.approvedBy}.`
      : "No approver is recorded on the invoice.",
    filePath: invoice.filePath,
  });

  const vendor = await one(db.select().from(vendors).where(eq(vendors.id, invoice.vendorId)));
  if (vendor) {
    ev.cite({
      table: "vendors",
      id: vendor.id,
      field: "name",
      value: vendor.name,
      reason: "Vendor the invoice was issued by.",
    });
  }

  const contract = await one(
    db.select().from(contracts).where(eq(contracts.vendorId, invoice.vendorId)),
  );
  if (!contract) {
    ev.gap(
      "other",
      `No contract on file for vendor ${vendor?.name ?? invoice.vendorId}, so invoice ${invoice.invoiceNumber} cannot be checked against an agreed rate.`,
    );
  } else {
    const rate = toCents(contract.monthlyRate);
    ev.cite({
      table: "contracts",
      id: contract.id,
      field: "monthly_rate",
      value: usd(rate),
      reason: `Contract fixes the monthly fee at ${usd(rate)}.`,
      filePath: contract.filePath,
    });
    ev.cite({
      table: "contracts",
      id: contract.id,
      field: "effective_from",
      value: contract.effectiveFrom,
      reason: "Start of the contract term.",
      filePath: contract.filePath,
    });
    ev.cite({
      table: "contracts",
      id: contract.id,
      field: "effective_to",
      value: contract.effectiveTo,
      reason: "End of the contract term; billing stops on this date.",
      filePath: contract.filePath,
    });

    if (amount !== rate) {
      const diff = amount - rate;
      const pct = ((Math.abs(diff) / rate) * 100).toFixed(1);
      ev.gap(
        "rate_mismatch",
        `Invoice ${invoice.invoiceNumber} bills ${usd(amount)}, which is ${usd(Math.abs(diff))} (${pct}%) ${diff > 0 ? "above" : "below"} the contract monthly rate of ${usd(rate)}.`,
      );
    }
    if (invoice.issueDate < contract.effectiveFrom || invoice.issueDate > contract.effectiveTo) {
      ev.gap(
        "outside_contract_term",
        `Invoice ${invoice.invoiceNumber} is dated ${invoice.issueDate}, outside the contract term ${contract.effectiveFrom} to ${contract.effectiveTo}.`,
      );
    }
  }

  if (!invoice.approvedBy && amount > MATCHING.approvalThresholdCents) {
    ev.gap(
      "missing_approval",
      `Invoice ${invoice.invoiceNumber} for ${usd(amount)} has approved_by null; invoices above ${usd(MATCHING.approvalThresholdCents)} require a named approver.`,
    );
  }

  const siblings = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.vendorId, invoice.vendorId), ne(invoices.id, invoice.id)));
  const sameMonth = siblings
    .filter((s) => monthKey(s.issueDate) === monthKey(invoice.issueDate))
    .sort((a, b) => a.id - b.id);
  if (sameMonth.length > 0) {
    for (const s of sameMonth) {
      ev.cite({
        table: "invoices",
        id: s.id,
        field: "invoice_number",
        value: s.invoiceNumber,
        reason: `Second invoice from the same vendor dated in ${monthKey(invoice.issueDate)} (${s.issueDate}, ${usd(toCents(s.amount))}).`,
        filePath: s.filePath,
      });
    }
    const numbers = [invoice, ...sameMonth]
      .sort((a, b) => a.id - b.id)
      .map((i) => i.invoiceNumber)
      .join(", ");
    ev.gap(
      "duplicate_invoice_month",
      `${vendor?.name ?? "This vendor"} issued ${sameMonth.length + 1} invoices dated in ${monthKey(invoice.issueDate)} (${numbers}); the contract invoices each month exactly once.`,
    );
  }

  await checkLedger(ev, {
    label: `Invoice ${invoice.invoiceNumber}`,
    sourceTypes: ["invoice"],
    sourceId: invoice.id,
  });
}

/** Finds the bank payment(s) behind an invoice and flags duplicates or no payment at all. */
async function linkPayments(ev: Evidence, invoice: Invoice): Promise<Bank[]> {
  const matches = await bankMatchesForInvoice(invoice);
  for (const b of matches) {
    citeBankRow(ev, b, `Bank payment matched to invoice ${invoice.invoiceNumber}.`);
    await checkLedger(ev, {
      label: `Bank transaction ${b.reference}`,
      sourceTypes: ["bank", "payroll"],
      sourceId: b.id,
    });
  }

  const amount = toCents(invoice.amount);
  if (matches.length === 0) {
    ev.gap(
      "no_bank_match",
      `No bank payment of ${usd(amount)} to this vendor sits inside invoice ${invoice.invoiceNumber}'s payment window (${addDays(invoice.issueDate, -MATCHING.paymentWindowDays)} to ${addDays(invoice.dueDate, MATCHING.paymentWindowDays)}).`,
    );
  } else if (matches.length > 1) {
    const detail = matches.map((b) => `#${b.id} on ${b.date}`).join(" and ");
    ev.gap(
      "duplicate_payment",
      `Invoice ${invoice.invoiceNumber} for ${usd(amount)} was settled ${matches.length} times in the bank feed (${detail}), overpaying by ${usd(amount * (matches.length - 1))}.`,
    );
  }
  return matches;
}

async function bankMatchesForInvoice(invoice: Invoice): Promise<Bank[]> {
  const exact = await db
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.reference, invoice.invoiceNumber));

  const vendor = await one(db.select().from(vendors).where(eq(vendors.id, invoice.vendorId)));
  let fuzzy: Bank[] = [];
  if (vendor) {
    const candidates = await db
      .select()
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.counterparty, vendor.name),
          eq(bankTransactions.amount, negate(invoice.amount)),
          gte(bankTransactions.date, addDays(invoice.issueDate, -MATCHING.paymentWindowDays)),
          lte(bankTransactions.date, addDays(invoice.dueDate, MATCHING.paymentWindowDays)),
        ),
      );
    // A bank line that quotes another invoice's number belongs to that invoice.
    fuzzy = await withoutInvoiceReferences(
      candidates.filter((c) => !exact.some((e) => e.id === c.id)),
    );
  }
  return [...exact, ...fuzzy].sort((a, b) => a.id - b.id);
}

async function withoutInvoiceReferences(rows: Bank[]): Promise<Bank[]> {
  if (rows.length === 0) return [];
  const claimed = await db
    .select({ invoiceNumber: invoices.invoiceNumber })
    .from(invoices)
    .where(
      inArray(
        invoices.invoiceNumber,
        rows.map((r) => r.reference),
      ),
    );
  const taken = new Set(claimed.map((c) => c.invoiceNumber));
  return rows.filter((r) => !taken.has(r.reference));
}

// ---------- bank transactions ----------

async function bankCore(ev: Evidence, bank: Bank) {
  const amount = toCents(bank.amount);
  citeBankRow(ev, bank, "The sampled bank line.");

  const vendor = await one(
    db.select().from(vendors).where(eq(vendors.name, bank.counterparty)),
  );
  const isPayroll = bank.counterparty === PAYROLL_COUNTERPARTY;
  const isDodo = bank.counterparty === DODO_COUNTERPARTY;
  const isOwnBank = bank.counterparty === BANK_COUNTERPARTY;

  if (vendor) {
    ev.cite({
      table: "vendors",
      id: vendor.id,
      field: "name",
      value: vendor.name,
      reason: "Counterparty is a vendor with a contract on file.",
    });
  } else if (amount < 0 && !isPayroll && !isDodo && !isOwnBank) {
    const notable = Math.abs(amount) > MATCHING.unknownCounterpartyNotableCents;
    ev.gap(
      "unknown_counterparty",
      `Bank payment ${bank.reference} on ${bank.date} sends ${usd(Math.abs(amount))} to "${bank.counterparty}", which is not a vendor with a contract, not payroll, and not Dodo Payments${notable ? `, and it is above the ${usd(MATCHING.unknownCounterpartyNotableCents)} review threshold` : ""}.`,
    );
  }

  const linked = await invoicesForBankRow(bank, vendor);
  for (const invoice of linked) {
    await invoiceCore(ev, invoice);
    await linkPayments(ev, invoice);
  }
  if (vendor && amount < 0 && linked.length === 0) {
    ev.gap(
      "no_matching_invoice",
      `Bank payment ${bank.reference} on ${bank.date} pays vendor ${vendor.name} ${usd(Math.abs(amount))}, but no invoice for that amount was issued inside the payment window (${MATCHING.paymentWindowDays} days either side of issue and net-30 due dates).`,
    );
  }

  await checkLedger(ev, {
    label: `Bank transaction ${bank.reference}`,
    sourceTypes: ["bank", "payroll"],
    sourceId: bank.id,
  });

  await scanOrphanCashLines(ev, bank.date);

  if (isDodo) {
    const payout = await one(
      db
        .select()
        .from(dodoTransactions)
        .where(
          and(eq(dodoTransactions.type, "payout"), eq(dodoTransactions.reference, bank.reference)),
        ),
    );
    if (payout) await dodoPayoutChecks(ev, payout, await allDodoRows());
  }
}

async function invoicesForBankRow(bank: Bank, vendor: Vendor | undefined): Promise<Invoice[]> {
  const exact = await db
    .select()
    .from(invoices)
    .where(eq(invoices.invoiceNumber, bank.reference));
  if (exact.length > 0) return exact;
  if (!vendor || toCents(bank.amount) >= 0) return [];

  const sameAmount = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.vendorId, vendor.id), eq(invoices.amount, absolute(bank.amount))));
  return sameAmount
    .filter(
      (i) =>
        bank.date >= addDays(i.issueDate, -MATCHING.paymentWindowDays) &&
        bank.date <= addDays(i.dueDate, MATCHING.paymentWindowDays),
    )
    .sort((a, b) => a.id - b.id);
}

/**
 * Every ledger Cash line near the sample must trace back to a bank transaction.
 * Issue 8 in the seed is a cash credit booked as an adjustment with no bank
 * line behind it on any date, so it surfaces here.
 */
async function scanOrphanCashLines(ev: Evidence, date: string) {
  const from = addDays(date, -MATCHING.cashScanWindowDays);
  const to = addDays(date, MATCHING.cashScanWindowDays);
  const cash = await db
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.account, CASH_ACCOUNT),
        gte(ledgerEntries.date, from),
        lte(ledgerEntries.date, to),
      ),
    );

  const sourced = cash.filter(
    (l) => (l.sourceType === "bank" || l.sourceType === "payroll") && l.sourceId !== null,
  );
  const existing = new Set<number>();
  if (sourced.length > 0) {
    const rows = await db
      .select({ id: bankTransactions.id })
      .from(bankTransactions)
      .where(
        inArray(
          bankTransactions.id,
          sourced.map((l) => l.sourceId as number),
        ),
      );
    for (const r of rows) existing.add(r.id);
  }

  for (const line of cash.sort((a, b) => a.id - b.id)) {
    const traced =
      (line.sourceType === "bank" || line.sourceType === "payroll") &&
      line.sourceId !== null &&
      existing.has(line.sourceId);
    if (traced) continue;
    ev.cite({
      table: "ledger_entries",
      id: line.id,
      field: line.debit === "0.00" ? "credit" : "debit",
      value: usd(toCents(line.debit === "0.00" ? line.credit : line.debit)),
      reason: `Cash line "${line.memo}" on ${line.date} booked as source_type ${line.sourceType} with no bank transaction behind it.`,
    });
    ev.gap(
      "no_bank_match",
      `Ledger entry #${line.id} on ${line.date} moves ${usd(toCents(line.debit === "0.00" ? line.credit : line.debit))} through Cash ("${line.memo}") but no bank transaction backs it.`,
    );
  }
}

// ---------- Dodo Payments ----------

async function dodoCore(ev: Evidence, dodo: Dodo) {
  const all = await allDodoRows();
  const amount = toCents(dodo.amount);

  // A payout's amount is cited by dodoPayoutChecks together with the month's
  // reconciliation, which is stronger evidence than the bare number.
  if (dodo.type !== "payout") {
    citeDodoAmount(ev, dodo, `The sampled Dodo Payments record. ${cap(dodo.type)} of ${usd(amount)} on ${dodo.date}.`);
  }
  citeDodoReference(ev, dodo);

  // A refund or dispute quotes its original payment ("ref_x for pay_y"), and it
  // rolls into the payout for the month of that payment, not of its own date.
  const originalRef = linkedPaymentReference(dodo.reference);
  const original = originalRef
    ? all.find((d) => d.type === "payment" && d.reference === originalRef)
    : undefined;
  if (original) {
    citeDodoRow(ev, original, `Original payment this ${dodo.type} was raised against.`);
  }
  const month = original ? monthOf(original.date) : monthOf(dodo.date);

  const outcome = disputeOutcome(dodo.reference);
  const ledgerRequired =
    dodo.type === "payment" ||
    dodo.type === "refund" ||
    dodo.type === "payout" ||
    (dodo.type === "dispute" && outcome === "lost");
  await checkLedger(ev, {
    label: `Dodo ${dodo.type} ${shortRef(dodo.reference)} for ${usd(amount)}`,
    sourceTypes: ["dodo"],
    sourceId: dodo.id,
    required: ledgerRequired,
    missingNote:
      dodo.type === "dispute"
        ? "A lost dispute is a cash loss and must be booked."
        : undefined,
  });

  // Refunds and lost disputes raised against a sampled payment are part of its story.
  if (dodo.type === "payment") {
    const followUps = await db
      .select()
      .from(dodoTransactions)
      .where(
        and(
          or(eq(dodoTransactions.type, "refund"), eq(dodoTransactions.type, "dispute")),
          like(dodoTransactions.reference, `%for ${dodo.reference}%`),
        ),
      );
    for (const f of followUps.sort((a, b) => a.id - b.id)) {
      citeDodoRow(ev, f, `${cap(f.type)} raised against this payment on ${f.date}.`);
      const fOutcome = disputeOutcome(f.reference);
      await checkLedger(ev, {
        label: `Dodo ${f.type} ${shortRef(f.reference)} for ${usd(toCents(f.amount))}`,
        sourceTypes: ["dodo"],
        sourceId: f.id,
        required: f.type === "refund" || fOutcome === "lost",
      });
    }
  }

  const payout =
    dodo.type === "payout" ? dodo : all.find((d) => d.type === "payout" && monthOf(d.date) === month);
  if (!payout) {
    ev.gap(
      "other",
      `No Dodo payout row exists for month ${month}, so this ${dodo.type} cannot be traced to a settlement.`,
    );
    return;
  }
  await dodoPayoutChecks(ev, payout, all);
}

/** Payout = payments - refunds - fees for the month; states the difference when it is not. */
async function dodoPayoutChecks(ev: Evidence, payout: Dodo, all: Dodo[]) {
  const month = monthOf(payout.date);
  const byReference = new Map(all.map((d) => [d.reference, d]));
  const monthOfRow = (row: Dodo) => {
    const ref = linkedPaymentReference(row.reference);
    const original = ref ? byReference.get(ref) : undefined;
    return monthOf((original ?? row).date);
  };

  const payments = all.filter((d) => d.type === "payment" && monthOf(d.date) === month);
  const refunds = all.filter((d) => d.type === "refund" && monthOfRow(d) === month);
  const paymentTotal = payments.reduce((s, p) => s + toCents(p.amount), 0);
  const refundTotal = refunds.reduce((s, r) => s + toCents(r.amount), 0);
  const feeTotal = payments.reduce((s, p) => s + dodoFeeCents(toCents(p.amount)), 0);
  const expected = paymentTotal - refundTotal - feeTotal;
  const actual = toCents(payout.amount);

  citeDodoReference(ev, payout);
  ev.cite({
    table: "dodo_transactions",
    id: payout.id,
    field: "amount",
    value: usd(actual),
    reason: `Month ${month} payout: ${payments.length} payments ${usd(paymentTotal)} less refunds ${usd(refundTotal)} less fees ${usd(feeTotal)} (4% + $0.40 each) is ${usd(expected)}.`,
  });

  if (expected !== actual) {
    const diff = expected - actual;
    const unrecorded = all.filter(
      (d) => d.type === "dispute" && monthOfRow(d) === month && disputeOutcome(d.reference) === "lost",
    );
    for (const d of unrecorded) {
      citeDodoRow(ev, d, `Lost dispute in month ${month} that Dodo withheld from the payout.`);
    }
    const explain = unrecorded
      .filter((d) => toCents(d.amount) === Math.abs(diff))
      .map((d) => `lost dispute ${shortRef(d.reference)} for ${usd(toCents(d.amount))}`)
      .join(", ");
    ev.gap(
      "payout_mismatch",
      `Month ${month} payout ${shortRef(payout.reference)} is ${usd(actual)} but payments less refunds less fees is ${usd(expected)}, a difference of ${usd(diff)}${explain ? ` which equals the ${explain}` : ""}.`,
    );
  }

  const deposit = await one(
    db.select().from(bankTransactions).where(eq(bankTransactions.reference, payout.reference)),
  );
  if (!deposit) {
    ev.gap(
      "no_bank_match",
      `Dodo payout ${shortRef(payout.reference)} for ${usd(actual)} never landed in the bank feed.`,
    );
    return;
  }
  citeBankRow(ev, deposit, `Bank deposit of the month ${month} Dodo payout.`);
  await checkLedger(ev, {
    label: `Bank transaction ${deposit.reference}`,
    sourceTypes: ["bank", "payroll"],
    sourceId: deposit.id,
  });
}

async function allDodoRows(): Promise<Dodo[]> {
  const rows = await db.select().from(dodoTransactions);
  return rows.sort((a, b) => a.id - b.id);
}

// ---------- ledger ----------

async function checkLedger(
  ev: Evidence,
  opts: {
    label: string;
    sourceTypes: string[];
    sourceId: number;
    required?: boolean;
    missingNote?: string;
  },
) {
  const rows = await db
    .select()
    .from(ledgerEntries)
    .where(
      and(
        inArray(ledgerEntries.sourceType, opts.sourceTypes),
        eq(ledgerEntries.sourceId, opts.sourceId),
      ),
    );
  const sorted = rows.sort((a, b) => a.id - b.id);
  for (const line of sorted) {
    const isDebit = toCents(line.debit) !== 0;
    ev.cite({
      table: "ledger_entries",
      id: line.id,
      field: isDebit ? "debit" : "credit",
      value: usd(toCents(isDebit ? line.debit : line.credit)),
      reason: `${isDebit ? "Debit" : "Credit"} ${line.account} on ${line.date}: ${line.memo}.`,
    });
  }

  if (opts.required === false) return;
  const debits = sorted.filter((l) => toCents(l.debit) !== 0);
  const credits = sorted.filter((l) => toCents(l.credit) !== 0);
  if (sorted.length === 0) {
    ev.gap(
      "missing_ledger_entry",
      `${opts.label} has no ledger entry (no rows with source_type in ${opts.sourceTypes.join("/")} and source_id ${opts.sourceId}).${opts.missingNote ? ` ${opts.missingNote}` : ""}`,
    );
  } else if (debits.length === 0 || credits.length === 0) {
    ev.gap(
      "missing_ledger_entry",
      `${opts.label} is booked with ${debits.length} debit and ${credits.length} credit lines; a balanced entry needs both.`,
    );
  }
}

// ---------- small helpers ----------

function citeBankRow(ev: Evidence, bank: Bank, reason: string) {
  const amount = toCents(bank.amount);
  ev.cite({
    table: "bank_transactions",
    id: bank.id,
    field: "amount",
    value: usd(amount),
    reason: `${reason} ${bank.description} on ${bank.date}.`,
  });
  ev.cite({
    table: "bank_transactions",
    id: bank.id,
    field: "reference",
    value: bank.reference,
    reason: `Bank reference for the ${amount < 0 ? "payment" : "deposit"} to ${bank.counterparty}.`,
  });
  ev.cite({
    table: "bank_transactions",
    id: bank.id,
    field: "counterparty",
    value: bank.counterparty,
    reason: `Counterparty on the ${bank.date} bank line.`,
  });
}

function citeDodoAmount(ev: Evidence, dodo: Dodo, reason: string) {
  ev.cite({
    table: "dodo_transactions",
    id: dodo.id,
    field: "amount",
    value: usd(toCents(dodo.amount)),
    reason,
  });
}

function citeDodoReference(ev: Evidence, dodo: Dodo) {
  ev.cite({
    table: "dodo_transactions",
    id: dodo.id,
    field: "reference",
    value: dodo.reference,
    reason: `Dodo reference for the ${dodo.type}${dodo.customerId ? ` from customer ${dodo.customerId}` : ""}.`,
  });
}

function citeDodoRow(ev: Evidence, dodo: Dodo, reason: string) {
  citeDodoAmount(
    ev,
    dodo,
    `${reason} ${cap(dodo.type)} of ${usd(toCents(dodo.amount))} on ${dodo.date}.`,
  );
  citeDodoReference(ev, dodo);
}

/** "ref_abc for pay_xyz" -> "pay_xyz"; "dsp_abc for pay_xyz (lost)" -> "pay_xyz". */
function linkedPaymentReference(reference: string): string | undefined {
  const match = reference.match(/ for (pay_[a-z0-9]+)/);
  return match?.[1];
}

function disputeOutcome(reference: string): "won" | "lost" | undefined {
  if (reference.includes("(lost)")) return "lost";
  if (reference.includes("(won)")) return "won";
  return undefined;
}

function shortRef(reference: string): string {
  return reference.split(" ")[0];
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function negate(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : `-${amount}`;
}

function absolute(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : amount;
}

async function one<T>(query: PromiseLike<T[]>): Promise<T | undefined> {
  const rows = await query;
  return rows[0];
}

function requireRow<T>(row: T | undefined, sample: SampleRef): asserts row is T {
  if (!row) throw new Error(`No row for sample ${formatSampleId(sample)}.`);
}

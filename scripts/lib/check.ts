/**
 * Seed self-check. Reads data/planted_issues.json and the database, asserts
 * that every planted issue is detectable and that nothing else is off.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "../../src/db";
import { dodoFee } from "./generate";
import { parseCents, usd } from "./util";

export type CheckResult = { name: string; ok: boolean; detail: string };

type Manifest = {
  issues: {
    id: number;
    slug: string;
    records: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    amounts: Record<string, string>;
  }[];
};

const PAYROLL = "Northwind Labs Payroll";
const DODO = "Dodo Payments";

export async function runChecks(): Promise<CheckResult[]> {
  const manifest: Manifest = JSON.parse(
    await readFile(path.join(process.cwd(), "data", "planted_issues.json"), "utf8"),
  );
  const issue = (id: number) => manifest.issues.find((i) => i.id === id)!;
  const out: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });

  // ---- load everything (small data, keep it simple) ----
  const vendors = await sql<{ id: number; name: string; contract_id: number | null }[]>`select * from vendors order by id`;
  const contracts = await sql<{ id: number; vendor_id: number; monthly_rate: string; effective_from: string; effective_to: string }[]>`
    select id, vendor_id, monthly_rate::text, effective_from::text, effective_to::text from contracts order by id`;
  const invoices = await sql<{ id: number; vendor_id: number; invoice_number: string; issue_date: string; amount: string; approved_by: string | null }[]>`
    select id, vendor_id, invoice_number, issue_date::text, amount::text, approved_by from invoices order by id`;
  const bank = await sql<{ id: number; date: string; amount: string; counterparty: string; reference: string }[]>`
    select id, date::text, amount::text, counterparty, reference from bank_transactions order by id`;
  const dodo = await sql<{ id: number; type: string; date: string; amount: string; reference: string }[]>`
    select id, type::text, date::text, amount::text, reference from dodo_transactions order by id`;
  const ledger = await sql<{ id: number; date: string; account: string; debit: string; credit: string; source_type: string; source_id: number | null }[]>`
    select id, date::text, account, debit::text, credit::text, source_type, source_id from ledger_entries order by id`;

  const vendorNames = new Set(vendors.map((v) => v.name));
  const contractByVendor = new Map(contracts.map((c) => [c.vendor_id, c]));
  const invoiceByNumber = new Map(invoices.map((i) => [i.invoice_number, i]));
  const bankByRef = groupBy(bank, (b) => b.reference);
  const ledgerBySource = groupBy(ledger, (l) => `${l.source_type}:${l.source_id}`);
  const month = (d: string) => Number(d.slice(5, 7));

  const plantedInvoiceIds = new Set<number>([
    issue(1).records.invoices.ids[0],
    issue(2).records.invoices.ids[0],
    issue(4).records.invoices.ids[0],
    issue(7).records.invoices.ids[0],
    issue(10).records.invoices.ids[0],
  ]);
  const plantedBankIds = new Set<number>([
    ...issue(1).records.bank_transactions.ids,
    ...issue(3).records.bank_transactions.ids,
    ...issue(9).records.bank_transactions.ids,
  ]);

  // ---- vendors / contracts ----
  check(
    "vendors.contract_id points at that vendor's contract",
    vendors.every((v) => contractByVendor.get(v.id)?.id === v.contract_id),
    `${vendors.length} vendors, ${contracts.length} contracts`,
  );

  // ---- planted issue 1: invoice paid twice ----
  {
    const inv = invoiceByNumber.get(issue(1).records.invoices.invoice_number)!;
    const pays = bankByRef.get(inv.invoice_number) ?? [];
    check("P1 invoice paid twice in bank feed", pays.length === 2 && pays.every((p) => parseCents(p.amount) === -parseCents(inv.amount)), `${inv.invoice_number}: ${pays.length} payments of ${usd(parseCents(inv.amount))}`);
  }
  // ---- planted issue 2: 15% over contract ----
  {
    const inv = invoiceByNumber.get(issue(2).records.invoices.invoice_number)!;
    const rate = parseCents(contractByVendor.get(inv.vendor_id)!.monthly_rate);
    check("P2 invoice billed 15% above contract rate", parseCents(inv.amount) === Math.round(rate * 1.15), `${inv.invoice_number}: ${usd(parseCents(inv.amount))} vs rate ${usd(rate)}`);
  }
  // ---- planted issue 3: bank payment with no invoice ----
  {
    const b = bank.find((x) => x.id === issue(3).records.bank_transactions.ids[0])!;
    check("P3 vendor bank payment with no invoice", vendorNames.has(b.counterparty) && !invoiceByNumber.has(b.reference), `${b.reference} to ${b.counterparty} ${usd(parseCents(b.amount))}`);
  }
  // ---- planted issue 4: >10k with approved_by null ----
  {
    const inv = invoiceByNumber.get(issue(4).records.invoices.invoice_number)!;
    const others = invoices.filter((i) => i.id !== inv.id && i.approved_by === null);
    check("P4 invoice over $10,000 with approved_by null (and no others)", parseCents(inv.amount) > 1_000_000 && inv.approved_by === null && others.length === 0, `${inv.invoice_number} ${usd(parseCents(inv.amount))}; other unapproved: ${others.length}`);
  }
  // ---- planted issue 5: refund with no ledger entry ----
  {
    const id = issue(5).records.dodo_transactions.ids[0];
    const r = dodo.find((d) => d.id === id)!;
    check("P5 Dodo refund with no ledger entry", r.type === "refund" && !ledgerBySource.has(`dodo:${id}`), `${r.reference} ${usd(parseCents(r.amount))} on ${r.date}`);
  }
  // ---- planted issue 6: payout short by unrecorded dispute ----
  const dodoMonth = (m: number) => {
    const rows = dodo.filter((d) => month(d.date) === m);
    const payments = rows.filter((d) => d.type === "payment");
    return {
      payments: sum(payments.map((d) => parseCents(d.amount))),
      fees: sum(payments.map((d) => dodoFee(parseCents(d.amount)))),
      refunds: sum(rows.filter((d) => d.type === "refund").map((d) => parseCents(d.amount))),
      payout: rows.find((d) => d.type === "payout")!,
    };
  };
  {
    const rec = issue(6).records.dodo_transactions;
    const t = dodoMonth(rec.month);
    const dispute = dodo.find((d) => d.id === rec.dispute_id)!;
    const expected = t.payments - t.refunds - t.fees;
    const actual = parseCents(t.payout.amount);
    check("P6 Dodo payout short by exactly the unrecorded lost dispute", expected - actual === parseCents(dispute.amount) && !ledgerBySource.has(`dodo:${dispute.id}`), `month ${rec.month}: expected ${usd(expected)}, actual ${usd(actual)}, dispute ${usd(parseCents(dispute.amount))}`);
  }
  // ---- planted issue 7: invoice after contract end ----
  {
    const inv = invoiceByNumber.get(issue(7).records.invoices.invoice_number)!;
    const c = contractByVendor.get(inv.vendor_id)!;
    check("P7 invoice dated after contract effective_to", inv.issue_date > c.effective_to, `${inv.invoice_number} ${inv.issue_date} > ${c.effective_to}`);
  }
  // ---- planted issue 8: ledger entry with no bank transaction ----
  {
    const ids: number[] = issue(8).records.ledger_entries.ids;
    const rows = ledger.filter((l) => ids.includes(l.id));
    const cashLine = rows.find((l) => l.account === "Cash")!;
    const amt = parseCents(cashLine.credit) - parseCents(cashLine.debit);
    const match = bank.filter((b) => parseCents(b.amount) === -amt);
    check("P8 ledger cash entry with no matching bank transaction", rows.length === 2 && rows.every((l) => l.source_type === "adjustment") && match.length === 0, `${cashLine.date} ${usd(amt)}; bank rows with that amount: ${match.length}`);
  }
  // ---- planted issue 9: unknown counterparty over 5,000 ----
  {
    const known = (c: string) => vendorNames.has(c) || c === PAYROLL || c === DODO;
    const big = bank.filter((b) => parseCents(b.amount) <= -500_000 && !known(b.counterparty));
    check("P9 exactly one bank payment over $5,000 to an unknown counterparty", big.length === 1 && big[0].id === issue(9).records.bank_transactions.ids[0], big.map((b) => `${b.counterparty} ${usd(parseCents(b.amount))}`).join(", "));
  }
  // ---- planted issue 10: two invoices in one month ----
  {
    const key = (i: { vendor_id: number; issue_date: string }) => `${i.vendor_id}:${month(i.issue_date)}`;
    const groups = groupBy(invoices, key);
    const dups = [...groups.values()].filter((g) => g.length > 1);
    const extraId = issue(10).records.invoices.ids[0];
    check("P10 exactly one vendor-month with two invoices", dups.length === 1 && dups[0].length === 2 && dups[0].some((i) => i.id === extraId), dups.map((g) => g.map((i) => i.invoice_number).join(" + ")).join("; "));
  }

  // ---- everything else reconciles ----
  {
    const bad: string[] = [];
    for (const inv of invoices) {
      if (plantedInvoiceIds.has(inv.id)) continue;
      const c = contractByVendor.get(inv.vendor_id)!;
      if (parseCents(inv.amount) !== parseCents(c.monthly_rate)) bad.push(`${inv.invoice_number} amount`);
      if (inv.approved_by === null) bad.push(`${inv.invoice_number} approver`);
      if (inv.issue_date < c.effective_from || inv.issue_date > c.effective_to) bad.push(`${inv.invoice_number} term`);
    }
    check("every non-planted invoice is at contract rate, approved, inside its term", bad.length === 0, bad.length ? bad.join(", ") : `${invoices.length - plantedInvoiceIds.size} invoices`);
  }
  {
    const bad: string[] = [];
    const paidTwice = issue(1).records.invoices.invoice_number;
    for (const inv of invoices) {
      const pays = bankByRef.get(inv.invoice_number) ?? [];
      const want = inv.invoice_number === paidTwice ? 2 : 1;
      if (pays.length !== want || !pays.every((p) => parseCents(p.amount) === -parseCents(inv.amount))) bad.push(`${inv.invoice_number}: ${pays.length}`);
    }
    check("every invoice has exactly one bank payment for its amount (P1 has two)", bad.length === 0, bad.length ? bad.join(", ") : `${invoices.length} invoices`);
  }
  {
    const bad = bank.filter((b) => vendorNames.has(b.counterparty) && !invoiceByNumber.has(b.reference) && !plantedBankIds.has(b.id));
    check("every non-planted vendor bank payment references a real invoice", bad.length === 0, bad.length ? bad.map((b) => b.reference).join(", ") : `${bank.filter((b) => vendorNames.has(b.counterparty)).length} vendor payments`);
  }
  {
    const bad = bank.filter((b) => vendorNames.has(b.counterparty) && invoiceByNumber.has(b.reference) && invoiceByNumber.get(b.reference)!.vendor_id !== vendors.find((v) => v.name === b.counterparty)!.id);
    check("vendor payment counterparty names match the invoice's vendor exactly", bad.length === 0, bad.length ? bad.map((b) => b.reference).join(", ") : "ok");
  }
  {
    const planted = issue(5).records.dodo_transactions.ids[0];
    const bad = dodo.filter((d) => d.type === "refund" && d.id !== planted && !ledgerBySource.has(`dodo:${d.id}`));
    check("every non-planted Dodo refund has a ledger entry", bad.length === 0, bad.length ? bad.map((d) => d.reference).join(", ") : `${dodo.filter((d) => d.type === "refund").length - 1} refunds`);
  }
  {
    const bad = dodo.filter((d) => d.type === "payment" && !ledgerBySource.has(`dodo:${d.id}`));
    check("every Dodo payment has a ledger entry", bad.length === 0, `${dodo.filter((d) => d.type === "payment").length} payments`);
  }
  {
    const plantedMonth = issue(6).records.dodo_transactions.month;
    const bad: string[] = [];
    for (let m = 1; m <= 12; m++) {
      if (m === plantedMonth) continue;
      const t = dodoMonth(m);
      if (t.payments - t.refunds - t.fees !== parseCents(t.payout.amount)) bad.push(`month ${m}`);
    }
    check("every non-planted Dodo payout = payments - refunds - fees (4% + $0.40 each)", bad.length === 0, bad.length ? bad.join(", ") : "11 months exact");
  }
  {
    const bad = dodo.filter((d) => d.type === "payout").filter((p) => {
      const rows = bankByRef.get(p.reference) ?? [];
      return rows.length !== 1 || parseCents(rows[0].amount) !== parseCents(p.amount) || rows[0].counterparty !== DODO;
    });
    check("every Dodo payout appears once in the bank feed for the same amount", bad.length === 0, `${dodo.filter((d) => d.type === "payout").length} payouts`);
  }
  {
    const wonDisputes = dodo.filter((d) => d.type === "dispute" && d.reference.endsWith("(won)"));
    const lost = dodo.filter((d) => d.type === "dispute" && d.reference.endsWith("(lost)"));
    check("disputes: 4 won (no cash impact) and exactly 1 lost (P6)", wonDisputes.length === 4 && lost.length === 1 && lost[0].id === issue(6).records.dodo_transactions.dispute_id, `${wonDisputes.length} won, ${lost.length} lost`);
  }
  {
    const bad = bank.filter((b) => !ledgerBySource.has(`bank:${b.id}`) && !ledgerBySource.has(`payroll:${b.id}`));
    check("every bank transaction has a ledger entry", bad.length === 0, bad.length ? bad.map((b) => b.reference).join(", ") : `${bank.length} bank transactions`);
  }
  {
    const bankById = new Map(bank.map((b) => [b.id, b]));
    const plantedLedger: number[] = issue(8).records.ledger_entries.ids;
    const bad = ledger.filter((l) => {
      if (l.account !== "Cash" || plantedLedger.includes(l.id)) return false;
      if (l.source_type !== "bank" && l.source_type !== "payroll") return true;
      const b = bankById.get(l.source_id!);
      return !b || parseCents(b.amount) !== parseCents(l.debit) - parseCents(l.credit);
    });
    check("every non-planted ledger Cash line matches its bank transaction", bad.length === 0, bad.length ? bad.map((l) => l.id).join(", ") : `${ledger.filter((l) => l.account === "Cash").length} cash lines`);
  }
  {
    const payroll = bank.filter((b) => b.counterparty === PAYROLL);
    check("semi-monthly payroll: 24 runs, all booked as source_type payroll", payroll.length === 24 && payroll.every((b) => ledgerBySource.has(`payroll:${b.id}`)), `${payroll.length} runs`);
  }
  {
    const debits = sum(ledger.map((l) => parseCents(l.debit)));
    const credits = sum(ledger.map((l) => parseCents(l.credit)));
    check("ledger debits equal credits", debits === credits, `debits ${usd(debits)}, credits ${usd(credits)}`);
  }
  {
    // Dodo Clearing should net to zero per month, except the P5 and P6 months.
    const p5 = issue(5), p6 = issue(6);
    const p5Month = month(p5.records.dodo_transactions.date);
    const p6Month: number = p6.records.dodo_transactions.month;
    const expect = new Map<number, number>([
      [p5Month, parseCents(p5.amounts.refund.replace(/[$,]/g, ""))],
      [p6Month, parseCents(p6.amounts.dispute.replace(/[$,]/g, ""))],
    ]);
    const bad: string[] = [];
    for (let m = 1; m <= 12; m++) {
      const rows = ledger.filter((l) => l.account === "Dodo Clearing" && month(l.date) === m);
      const bal = sum(rows.map((l) => parseCents(l.debit) - parseCents(l.credit)));
      if (bal !== (expect.get(m) ?? 0)) bad.push(`month ${m}: ${usd(bal)}`);
    }
    check("Dodo Clearing nets to zero each month except P5 (refund) and P6 (dispute)", bad.length === 0, bad.length ? bad.join(", ") : `months ${p5Month} and ${p6Month} carry the planted amounts`);
  }
  {
    const ids = manifest.issues.flatMap((i) => Object.entries(i.records).flatMap(([t, r]) => (Array.isArray((r as any).ids) ? (r as any).ids.map((id: number) => `${t}:${id}`) : []))); // eslint-disable-line @typescript-eslint/no-explicit-any
    const dupes = ids.filter((x, i) => ids.indexOf(x) !== i && !x.startsWith("contracts:") && !x.startsWith("vendors:"));
    check("planted issues touch distinct records (no primary record shared)", manifest.issues.length === 10 && dupes.length === 0, dupes.length ? dupes.join(", ") : "10 issues");
  }

  return out;
}

export function printChecks(results: CheckResult[]): boolean {
  console.log("Seed self-check");
  console.log("---------------");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed.`);
  return failed === 0;
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = m.get(k);
    if (arr) arr.push(r);
    else m.set(k, [r]);
  }
  return m;
}

function sum(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0);
}

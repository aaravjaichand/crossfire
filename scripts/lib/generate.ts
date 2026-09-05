/**
 * Pure, deterministic generator for one fiscal year (2025) of Northwind Labs.
 * No I/O here: it returns rows, PDF specs, and the planted-issue manifest.
 * Same SEED => byte-identical output.
 *
 * Money is integer cents everywhere in this file.
 */
import type { PdfLine } from "./pdf";
import {
  MONTH_NAMES,
  Rng,
  addDays,
  daysInMonth,
  iso,
  lastDay,
  longDate,
  monthOf,
  usd,
} from "./util";

export const YEAR = 2025;
export const SEED = 20250906;
export const COMPANY = "Northwind Labs, Inc.";

// Dodo Payments fee formula: 4.00% of the payment + $0.40, rounded to the cent,
// charged on payments only (refunds return the full amount, fees are kept).
export const DODO_FEE_BPS = 400;
export const DODO_FEE_FIXED_CENTS = 40;
export function dodoFee(amountCents: number): number {
  return Math.round((amountCents * DODO_FEE_BPS) / 10000) + DODO_FEE_FIXED_CENTS;
}

// Ledger account names used by the seed.
export const ACCOUNTS = {
  cash: "Cash",
  ap: "Accounts Payable",
  dodoClearing: "Dodo Clearing",
  revenue: "Revenue",
  refunds: "Refunds",
  fees: "Payment Processing Fees",
  salaries: "Salaries & Wages",
  bankFees: "Bank Fees",
  interest: "Interest Income",
  software: "Software Subscriptions",
  meals: "Meals & Entertainment",
  travel: "Travel",
  supplies: "Office Supplies",
  consulting: "Consulting Expense",
  marketing: "Marketing",
} as const;

export const PAYROLL_COUNTERPARTY = "Northwind Labs Payroll";
export const DODO_COUNTERPARTY = "Dodo Payments";
export const BANK_COUNTERPARTY = "Coastal Trust Bank";

// ---------- row types (ids are assigned by the generator; cents for money) ----------

export type VendorRow = { id: number; name: string; contractId: number | null };
export type ContractRow = {
  id: number;
  vendorId: number;
  filePath: string;
  monthlyRate: number;
  effectiveFrom: string;
  effectiveTo: string;
  termsText: string;
};
export type InvoiceRow = {
  id: number;
  vendorId: number;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  amount: number;
  status: string;
  approvedBy: string | null;
  filePath: string;
};
export type BankRow = {
  id: number;
  date: string;
  description: string;
  amount: number;
  counterparty: string;
  reference: string;
  // seed-only metadata used to build ledger lines; not persisted
  kind:
    | "vendor_payment"
    | "vendor_payment_no_invoice"
    | "unknown_wire"
    | "payout"
    | "payroll"
    | "bank_fee"
    | "interest"
    | "card";
  account?: string;
  vendorName?: string;
  month?: number;
};
export type DodoType = "payment" | "refund" | "dispute" | "payout";
export type DodoRow = {
  id: number;
  type: DodoType;
  date: string;
  amount: number;
  customerId: string | null;
  reference: string;
  // seed-only
  month: number;
  outcome?: "won" | "lost";
  paymentRef?: string;
};
export type LedgerRow = {
  id: number;
  date: string;
  account: string;
  debit: number;
  credit: number;
  memo: string;
  sourceType: "invoice" | "bank" | "dodo" | "payroll" | "adjustment";
  sourceId: number | null;
};
export type PdfFile = { path: string; lines: PdfLine[] };

export type PlantedIssue = {
  id: number;
  slug: string;
  description: string;
  records: Record<string, unknown>;
  amounts: Record<string, string>;
};

export type Generated = {
  vendors: VendorRow[];
  contracts: ContractRow[];
  invoices: InvoiceRow[];
  bank: BankRow[];
  dodo: DodoRow[];
  ledger: LedgerRow[];
  pdfs: PdfFile[];
  planted: PlantedIssue[];
};

// ---------- fixed fixtures ----------

type VendorDef = {
  code: string;
  slug: string;
  name: string;
  rate: number;
  account: string;
  item: string;
  service: string;
  effectiveFrom: string;
  effectiveTo: string;
  address: string;
};

const VENDOR_DEFS: VendorDef[] = [
  {
    code: "STR",
    slug: "stratus-compute",
    name: "Stratus Compute Inc.",
    rate: 1_850_000,
    account: "Cloud Infrastructure",
    item: "Reserved GPU cluster, 8 x H100 nodes, 24x7",
    service: "GPU cloud infrastructure",
    effectiveFrom: iso(YEAR, 1, 1),
    effectiveTo: iso(YEAR, 12, 31),
    address: "2200 Mission College Blvd, Santa Clara, CA 95054",
  },
  {
    code: "HPP",
    slug: "harbor-point-properties",
    name: "Harbor Point Properties LLC",
    rate: 920_000,
    account: "Rent",
    item: "Office lease, Suite 410, 88 Harbor Point Drive",
    service: "commercial office space",
    effectiveFrom: iso(YEAR, 1, 1),
    effectiveTo: iso(YEAR, 12, 31),
    address: "88 Harbor Point Drive, Boston, MA 02210",
  },
  {
    code: "NWK",
    slug: "notchwork-saas",
    name: "Notchwork SaaS Ltd.",
    rate: 145_000,
    account: ACCOUNTS.software,
    item: "Notchwork Team plan, 25 seats",
    service: "project tracking software",
    effectiveFrom: iso(YEAR, 1, 1),
    effectiveTo: iso(YEAR, 12, 31),
    address: "14 Clerkenwell Road, London EC1M 5PQ, UK",
  },
  {
    code: "MDC",
    slug: "meridian-design-collective",
    name: "Meridian Design Collective",
    rate: 680_000,
    account: "Contractors",
    item: "Product design retainer, 40 hours",
    service: "product design services",
    effectiveFrom: iso(YEAR, 1, 1),
    // Ends a month early on purpose: planted issue 7 is the December invoice.
    effectiveTo: iso(YEAR, 11, 30),
    address: "510 Congress Avenue, Austin, TX 78701",
  },
  {
    code: "BHI",
    slug: "bellhaven-insurance",
    name: "Bellhaven Insurance Group",
    rate: 235_000,
    account: "Insurance",
    item: "General liability and D&O coverage, monthly premium",
    service: "business insurance",
    effectiveFrom: iso(YEAR, 1, 1),
    effectiveTo: iso(YEAR, 12, 31),
    address: "1 Financial Plaza, Hartford, CT 06103",
  },
];

const APPROVERS = ["Priya Natarajan", "Marcus Webb", "Elena Fischer"];

// Planted-issue targets. Each lives on a distinct record.
const PLANT = {
  paidTwice: "HPP-2025-03", // 1
  overbilled: "STR-2025-05", // 2
  paymentNoInvoice: { vendor: "BHI", date: iso(YEAR, 6, 20), amount: 312_000, ref: "ACH-20250620-BHI" }, // 3
  unapproved: "STR-2025-09", // 4
  refundNoLedger: { month: 4 }, // 5 (first refund in April)
  lostDispute: { month: 10 }, // 6
  afterContract: "MDC-2025-12", // 7
  ledgerNoBank: { date: iso(YEAR, 8, 14), amount: 187_500 }, // 8
  unknownWire: { date: iso(YEAR, 9, 12), amount: 785_000, counterparty: "Kestrel Holdings Ltd", ref: "WIRE-20250912-4471" }, // 9
  duplicateMonth: { vendor: "NWK", month: 8, number: "NWK-2025-08B", issueDate: iso(YEAR, 8, 18) }, // 10
};

const PAYMENTS_PER_MONTH = [22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 43, 47]; // = 400
const REFUND_MONTHS = [1, 1, 2, 3, 3, 4, 4, 5, 6, 6, 7, 8, 8, 9, 9, 10, 11, 11, 12, 12]; // 20
const DISPUTE_MONTHS = [2, 5, 7, 10, 11]; // 5; month 10 is the lost one
const PLANS = [
  { value: 2_900, weight: 30 },
  { value: 4_900, weight: 30 },
  { value: 9_900, weight: 20 },
  { value: 19_900, weight: 12 },
  { value: 49_900, weight: 8 },
];

const SUBSCRIPTIONS = [
  { name: "Gitforge Cloud", amount: 21_000, day: 5 },
  { name: "Chatter Workspace", amount: 31_250, day: 8 },
  { name: "Pixelboard Design", amount: 9_000, day: 12 },
  { name: "Mailwave", amount: 6_500, day: 20 },
];
const CARD_MERCHANTS = [
  { name: "Lunch Box Deli", account: ACCOUNTS.meals, min: 1_200, max: 9_500 },
  { name: "Corner Bean Cafe", account: ACCOUNTS.meals, min: 600, max: 4_800 },
  { name: "Saffron Kitchen", account: ACCOUNTS.meals, min: 4_500, max: 26_000 },
  { name: "Brickhouse Pizza", account: ACCOUNTS.meals, min: 3_200, max: 18_000 },
  { name: "RideShare Co", account: ACCOUNTS.travel, min: 1_400, max: 6_800 },
  { name: "Sky Air Travel", account: ACCOUNTS.travel, min: 18_000, max: 89_000 },
  { name: "Harborview Hotel", account: ACCOUNTS.travel, min: 21_000, max: 74_000 },
  { name: "Metro Transit", account: ACCOUNTS.travel, min: 250, max: 1_200 },
  { name: "Stationery Depot", account: ACCOUNTS.supplies, min: 1_800, max: 24_000 },
  { name: "Byte Supply Co", account: ACCOUNTS.supplies, min: 4_500, max: 60_000 },
];
const CARD_SPEND_COUNT = 128;

// ---------- generator ----------

export function generate(): Generated {
  const rng = new Rng(SEED);
  const pdfs: PdfFile[] = [];
  const planted: PlantedIssue[] = [];

  // ---- vendors + contracts ----
  const vendors: VendorRow[] = VENDOR_DEFS.map((v, i) => ({
    id: i + 1,
    name: v.name,
    contractId: null,
  }));
  const contracts: ContractRow[] = VENDOR_DEFS.map((v, i) => {
    const id = i + 1;
    const filePath = `data/contracts/${v.slug}-contract.pdf`;
    const lines = contractLines(v, id);
    pdfs.push({ path: filePath, lines });
    return {
      id,
      vendorId: id,
      filePath,
      monthlyRate: v.rate,
      effectiveFrom: v.effectiveFrom,
      effectiveTo: v.effectiveTo,
      termsText: linesToText(lines),
    };
  });
  // vendors.contract_id is filled by the seed after contracts insert; we still
  // record the intended value here so the manifest and checks can use it.
  vendors.forEach((v, i) => (v.contractId = contracts[i].id));

  // ---- invoices ----
  const invoices: InvoiceRow[] = [];
  let invoiceId = 0;
  const vendorByCode = new Map(VENDOR_DEFS.map((v, i) => [v.code, { def: v, id: i + 1 }]));
  for (const [code, { def, id: vendorId }] of vendorByCode) {
    for (let m = 1; m <= 12; m++) {
      const number = `${code}-${YEAR}-${String(m).padStart(2, "0")}`;
      const issueDate = iso(YEAR, m, 1);
      let amount = def.rate;
      if (number === PLANT.overbilled) amount = Math.round(def.rate * 1.15);
      const approvedBy =
        number === PLANT.unapproved
          ? null
          : def.rate > 1_000_000
            ? APPROVERS[0]
            : rng.pick(APPROVERS);
      invoices.push(
        makeInvoice(++invoiceId, vendorId, def, number, issueDate, amount, approvedBy, pdfs),
      );
      if (code === PLANT.duplicateMonth.vendor && m === PLANT.duplicateMonth.month) {
        // Planted issue 10: a second invoice from the same vendor in the same month.
        invoices.push(
          makeInvoice(
            ++invoiceId,
            vendorId,
            def,
            PLANT.duplicateMonth.number,
            PLANT.duplicateMonth.issueDate,
            def.rate,
            rng.pick(APPROVERS),
            pdfs,
          ),
        );
      }
    }
  }
  const invoiceByNumber = new Map(invoices.map((i) => [i.invoiceNumber, i]));

  // ---- Dodo Payments ----
  const customers = Array.from({ length: 160 }, () => `cus_${rng.token(10)}`);
  const dodoUnsorted: Omit<DodoRow, "id">[] = [];
  const paymentsByMonth: Omit<DodoRow, "id">[][] = Array.from({ length: 13 }, () => []);
  for (let m = 1; m <= 12; m++) {
    const dim = daysInMonth(YEAR, m);
    const rows: Omit<DodoRow, "id">[] = [];
    for (let i = 0; i < PAYMENTS_PER_MONTH[m - 1]; i++) {
      rows.push({
        type: "payment",
        date: iso(YEAR, m, rng.int(1, dim)),
        amount: rng.weighted(PLANS),
        customerId: rng.pick(customers),
        reference: `pay_${rng.token(14)}`,
        month: m,
      });
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    paymentsByMonth[m] = rows;
    dodoUnsorted.push(...rows);
  }

  const usedPayments = new Set<string>();
  const pickPayment = (m: number, minAmount = 0) => {
    const eligible = paymentsByMonth[m].filter(
      (p) =>
        Number(p.date.slice(8)) <= 12 &&
        p.amount >= minAmount &&
        !usedPayments.has(p.reference),
    );
    const p = eligible[rng.int(0, eligible.length - 1)];
    usedPayments.add(p.reference);
    return p;
  };

  const refunds: Omit<DodoRow, "id">[] = [];
  for (const m of REFUND_MONTHS) {
    const p = pickPayment(m);
    refunds.push({
      type: "refund",
      date: addDays(p.date, rng.int(2, 14)),
      amount: p.amount,
      customerId: p.customerId,
      reference: `ref_${rng.token(12)} for ${p.reference}`,
      month: m,
      paymentRef: p.reference,
    });
  }
  dodoUnsorted.push(...refunds);

  const disputes: Omit<DodoRow, "id">[] = [];
  for (const m of DISPUTE_MONTHS) {
    const p = pickPayment(m, 9_900); // disputes hit the larger plans
    const outcome: "won" | "lost" = m === PLANT.lostDispute.month ? "lost" : "won";
    disputes.push({
      type: "dispute",
      date: addDays(p.date, rng.int(5, 16)),
      amount: p.amount,
      customerId: p.customerId,
      reference: `dsp_${rng.token(12)} for ${p.reference} (${outcome})`,
      month: m,
      outcome,
      paymentRef: p.reference,
    });
  }
  dodoUnsorted.push(...disputes);

  const monthTotals = Array.from({ length: 13 }, () => ({
    payments: 0,
    paymentCount: 0,
    refunds: 0,
    fees: 0,
    lostDisputes: 0,
    payout: 0,
  }));
  for (const p of dodoUnsorted) {
    const t = monthTotals[p.month];
    if (p.type === "payment") {
      t.payments += p.amount;
      t.paymentCount += 1;
      t.fees += dodoFee(p.amount);
    } else if (p.type === "refund") t.refunds += p.amount;
    else if (p.type === "dispute" && p.outcome === "lost") t.lostDisputes += p.amount;
  }
  const payouts: Omit<DodoRow, "id">[] = [];
  for (let m = 1; m <= 12; m++) {
    const t = monthTotals[m];
    // Payout = payments - refunds - fees. Only the planted lost dispute (issue 6)
    // is also withheld by Dodo; every other month matches the formula exactly.
    t.payout = t.payments - t.refunds - t.fees - t.lostDisputes;
    payouts.push({
      type: "payout",
      date: lastDay(YEAR, m),
      amount: t.payout,
      customerId: null,
      reference: `po_${YEAR}${String(m).padStart(2, "0")}_${rng.token(6)}`,
      month: m,
    });
  }
  dodoUnsorted.push(...payouts);

  const typeOrder: Record<DodoType, number> = { payment: 0, refund: 1, dispute: 2, payout: 3 };
  const dodo: DodoRow[] = dodoUnsorted
    .map((r, seq) => ({ r, seq }))
    .sort(
      (a, b) =>
        cmp(a.r.date, b.r.date) || typeOrder[a.r.type] - typeOrder[b.r.type] || a.seq - b.seq,
    )
    .map(({ r }, i) => ({ id: i + 1, ...r }));
  const payoutRowByMonth = new Map(dodo.filter((d) => d.type === "payout").map((d) => [d.month, d]));

  // ---- bank transactions ----
  const bankUnsorted: Omit<BankRow, "id">[] = [];

  for (const inv of invoices) {
    const def = VENDOR_DEFS[inv.vendorId - 1];
    const date = addDays(inv.issueDate, rng.int(8, 24));
    bankUnsorted.push({
      date,
      description: `ACH payment ${inv.invoiceNumber}`,
      amount: -inv.amount,
      counterparty: def.name,
      reference: inv.invoiceNumber,
      kind: "vendor_payment",
      vendorName: def.name,
    });
    if (inv.invoiceNumber === PLANT.paidTwice) {
      // Planted issue 1: the same invoice settled a second time.
      bankUnsorted.push({
        date: addDays(date, 3),
        description: `ACH payment ${inv.invoiceNumber}`,
        amount: -inv.amount,
        counterparty: def.name,
        reference: inv.invoiceNumber,
        kind: "vendor_payment",
        vendorName: def.name,
      });
    }
  }
  {
    // Planted issue 3: vendor payment with no invoice behind it.
    const def = vendorByCode.get(PLANT.paymentNoInvoice.vendor)!.def;
    bankUnsorted.push({
      date: PLANT.paymentNoInvoice.date,
      description: `ACH payment ${def.name}`,
      amount: -PLANT.paymentNoInvoice.amount,
      counterparty: def.name,
      reference: PLANT.paymentNoInvoice.ref,
      kind: "vendor_payment_no_invoice",
      vendorName: def.name,
    });
  }
  // Planted issue 9: large wire to a counterparty nobody recognises.
  bankUnsorted.push({
    date: PLANT.unknownWire.date,
    description: "Outgoing wire",
    amount: -PLANT.unknownWire.amount,
    counterparty: PLANT.unknownWire.counterparty,
    reference: PLANT.unknownWire.ref,
    kind: "unknown_wire",
    account: ACCOUNTS.consulting,
  });

  for (let m = 1; m <= 12; m++) {
    const payout = payoutRowByMonth.get(m)!;
    bankUnsorted.push({
      date: payout.date,
      description: "DODO PAYMENTS PAYOUT",
      amount: payout.amount,
      counterparty: DODO_COUNTERPARTY,
      reference: payout.reference,
      kind: "payout",
      month: m,
    });
    const payrollAmount = m <= 6 ? 4_680_000 : 4_990_000;
    for (const [n, day] of [[1, 15], [2, daysInMonth(YEAR, m)]] as const) {
      bankUnsorted.push({
        date: iso(YEAR, m, day),
        description: "PAYROLL RUN",
        amount: -payrollAmount,
        counterparty: PAYROLL_COUNTERPARTY,
        reference: `PR-${YEAR}-${String(m).padStart(2, "0")}-${n}`,
        kind: "payroll",
        account: ACCOUNTS.salaries,
      });
    }
    bankUnsorted.push({
      date: iso(YEAR, m, 3),
      description: "MONTHLY SERVICE FEE",
      amount: -4_500,
      counterparty: BANK_COUNTERPARTY,
      reference: `FEE-${YEAR}-${String(m).padStart(2, "0")}`,
      kind: "bank_fee",
      account: ACCOUNTS.bankFees,
    });
    bankUnsorted.push({
      date: lastDay(YEAR, m),
      description: "INTEREST PAID",
      amount: rng.int(5_200, 9_800),
      counterparty: BANK_COUNTERPARTY,
      reference: `INT-${YEAR}-${String(m).padStart(2, "0")}`,
      kind: "interest",
      account: ACCOUNTS.interest,
    });
    for (const s of SUBSCRIPTIONS) {
      bankUnsorted.push({
        date: iso(YEAR, m, s.day),
        description: `CARD PURCHASE ${s.name.toUpperCase()}`,
        amount: -s.amount,
        counterparty: s.name,
        reference: `CARD-${YEAR}${String(m).padStart(2, "0")}${String(s.day).padStart(2, "0")}-${rng.token(4, "0123456789")}`,
        kind: "card",
        account: ACCOUNTS.software,
      });
    }
  }
  for (let i = 0; i < CARD_SPEND_COUNT; i++) {
    const m = rng.int(1, 12);
    const d = rng.int(1, daysInMonth(YEAR, m));
    const merchant = rng.pick(CARD_MERCHANTS);
    bankUnsorted.push({
      date: iso(YEAR, m, d),
      description: `CARD PURCHASE ${merchant.name.toUpperCase()}`,
      amount: -rng.int(merchant.min, merchant.max),
      counterparty: merchant.name,
      reference: `CARD-${YEAR}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}-${rng.token(4, "0123456789")}`,
      kind: "card",
      account: merchant.account,
    });
  }
  const bank: BankRow[] = bankUnsorted
    .map((r, seq) => ({ r, seq }))
    .sort((a, b) => cmp(a.r.date, b.r.date) || a.seq - b.seq)
    .map(({ r }, i) => ({ id: i + 1, ...r }));

  // ---- ledger ----
  const ledgerUnsorted: Omit<LedgerRow, "id">[] = [];
  const journal = (
    date: string,
    debitAccount: string,
    creditAccount: string,
    amount: number,
    memo: string,
    sourceType: LedgerRow["sourceType"],
    sourceId: number | null,
  ) => {
    ledgerUnsorted.push({ date, account: debitAccount, debit: amount, credit: 0, memo, sourceType, sourceId });
    ledgerUnsorted.push({ date, account: creditAccount, debit: 0, credit: amount, memo, sourceType, sourceId });
  };

  for (const inv of invoices) {
    const def = VENDOR_DEFS[inv.vendorId - 1];
    journal(inv.issueDate, def.account, ACCOUNTS.ap, inv.amount, `Invoice ${inv.invoiceNumber} from ${def.name}`, "invoice", inv.id);
  }
  for (const b of bank) {
    const abs = Math.abs(b.amount);
    switch (b.kind) {
      case "vendor_payment":
      case "vendor_payment_no_invoice":
        journal(b.date, ACCOUNTS.ap, ACCOUNTS.cash, abs, `Payment ${b.reference} to ${b.counterparty}`, "bank", b.id);
        break;
      case "unknown_wire":
        journal(b.date, b.account!, ACCOUNTS.cash, abs, `Outgoing wire to ${b.counterparty} (${b.reference})`, "bank", b.id);
        break;
      case "payout":
        journal(b.date, ACCOUNTS.cash, ACCOUNTS.dodoClearing, abs, `Dodo payout ${b.reference} for ${MONTH_NAMES[b.month! - 1]} ${YEAR}`, "bank", b.id);
        break;
      case "payroll":
        journal(b.date, ACCOUNTS.salaries, ACCOUNTS.cash, abs, `Payroll ${b.reference}`, "payroll", b.id);
        break;
      case "bank_fee":
        journal(b.date, ACCOUNTS.bankFees, ACCOUNTS.cash, abs, `Bank service fee ${b.reference}`, "bank", b.id);
        break;
      case "interest":
        journal(b.date, ACCOUNTS.cash, ACCOUNTS.interest, abs, `Interest income ${b.reference}`, "bank", b.id);
        break;
      case "card":
        journal(b.date, b.account!, ACCOUNTS.cash, abs, `Card purchase ${b.counterparty} (${b.reference})`, "bank", b.id);
        break;
    }
  }
  let plantedRefund: DodoRow | null = null;
  let plantedDispute: DodoRow | null = null;
  for (const d of dodo) {
    if (d.type === "payment") {
      journal(d.date, ACCOUNTS.dodoClearing, ACCOUNTS.revenue, d.amount, `Dodo payment ${d.reference} from ${d.customerId}`, "dodo", d.id);
    } else if (d.type === "refund") {
      if (!plantedRefund && d.month === PLANT.refundNoLedger.month) {
        // Planted issue 5: this refund never made it into the ledger.
        plantedRefund = d;
        continue;
      }
      journal(d.date, ACCOUNTS.refunds, ACCOUNTS.dodoClearing, d.amount, `Dodo refund ${d.reference}`, "dodo", d.id);
    } else if (d.type === "dispute" && d.outcome === "lost") {
      // Planted issue 6: Dodo withheld this from the payout; the ledger never recorded it.
      plantedDispute = d;
    }
  }
  for (let m = 1; m <= 12; m++) {
    const t = monthTotals[m];
    const payout = payoutRowByMonth.get(m)!;
    journal(
      lastDay(YEAR, m),
      ACCOUNTS.fees,
      ACCOUNTS.dodoClearing,
      t.fees,
      `Dodo processing fees for ${MONTH_NAMES[m - 1]} ${YEAR} (4% + $0.40 on ${t.paymentCount} payments)`,
      "dodo",
      payout.id,
    );
  }
  // Planted issue 8: a cash entry with nothing behind it in the bank feed.
  journal(
    PLANT.ledgerNoBank.date,
    ACCOUNTS.marketing,
    ACCOUNTS.cash,
    PLANT.ledgerNoBank.amount,
    "Conference sponsorship, DevSummit 2025, paid by wire",
    "adjustment",
    null,
  );

  const ledger: LedgerRow[] = ledgerUnsorted
    .map((r, seq) => ({ r, seq }))
    .sort((a, b) => cmp(a.r.date, b.r.date) || a.seq - b.seq)
    .map(({ r }, i) => ({ id: i + 1, ...r }));

  // ---- planted issue manifest ----
  const inv = (n: string) => invoiceByNumber.get(n)!;
  const bankFor = (pred: (b: BankRow) => boolean) => bank.filter(pred);
  const ledgerFor = (pred: (l: LedgerRow) => boolean) => ledger.filter(pred);

  {
    const i = inv(PLANT.paidTwice);
    const payments = bankFor((b) => b.reference === i.invoiceNumber);
    planted.push({
      id: 1,
      slug: "invoice-paid-twice",
      description: `Invoice ${i.invoiceNumber} (${VENDOR_DEFS[i.vendorId - 1].name}) was settled twice in the bank feed, three days apart. Both payments are booked in the ledger.`,
      records: {
        invoices: { ids: [i.id], invoice_number: i.invoiceNumber },
        bank_transactions: { ids: payments.map((b) => b.id), references: payments.map((b) => b.reference), dates: payments.map((b) => b.date) },
        ledger_entries: { ids: ledgerFor((l) => l.sourceType === "bank" && payments.some((b) => b.id === l.sourceId)).map((l) => l.id) },
      },
      amounts: { invoice: usd(i.amount), each_payment: usd(i.amount), overpaid: usd(i.amount) },
    });
  }
  {
    const i = inv(PLANT.overbilled);
    const c = contracts[i.vendorId - 1];
    planted.push({
      id: 2,
      slug: "invoice-above-contract-rate",
      description: `Invoice ${i.invoiceNumber} bills 15% above the contract monthly rate. It was approved and paid at the billed amount.`,
      records: {
        invoices: { ids: [i.id], invoice_number: i.invoiceNumber },
        contracts: { ids: [c.id] },
        bank_transactions: { ids: bankFor((b) => b.reference === i.invoiceNumber).map((b) => b.id) },
      },
      amounts: { contract_rate: usd(c.monthlyRate), invoice: usd(i.amount), overbilled_by: usd(i.amount - c.monthlyRate) },
    });
  }
  {
    const b = bankFor((x) => x.kind === "vendor_payment_no_invoice")[0];
    planted.push({
      id: 3,
      slug: "bank-payment-without-invoice",
      description: `Bank payment ${b.reference} to ${b.counterparty} on ${b.date} has no invoice behind it. It was booked to Accounts Payable anyway.`,
      records: {
        bank_transactions: { ids: [b.id], reference: b.reference, counterparty: b.counterparty, date: b.date },
        vendors: { ids: [vendors.find((v) => v.name === b.counterparty)!.id] },
        ledger_entries: { ids: ledgerFor((l) => l.sourceType === "bank" && l.sourceId === b.id).map((l) => l.id) },
      },
      amounts: { payment: usd(-b.amount) },
    });
  }
  {
    const i = inv(PLANT.unapproved);
    planted.push({
      id: 4,
      slug: "large-invoice-not-approved",
      description: `Invoice ${i.invoiceNumber} is over $10,000 and has approved_by null. Every other invoice carries an approver.`,
      records: { invoices: { ids: [i.id], invoice_number: i.invoiceNumber, approved_by: null } },
      amounts: { invoice: usd(i.amount) },
    });
  }
  {
    const r = plantedRefund!;
    planted.push({
      id: 5,
      slug: "dodo-refund-missing-from-ledger",
      description: `Dodo refund ${r.reference.split(" ")[0]} on ${r.date} has no ledger entry. The ${MONTH_NAMES[r.month - 1]} payout correctly deducts it, so Dodo Clearing is left over-stated by the refund amount for that month.`,
      records: {
        dodo_transactions: { ids: [r.id], reference: r.reference, type: "refund", date: r.date, customer_id: r.customerId },
        ledger_entries: { expected_source: { source_type: "dodo", source_id: r.id }, found: [] },
      },
      amounts: { refund: usd(r.amount) },
    });
  }
  {
    const d = plantedDispute!;
    const payout = payoutRowByMonth.get(d.month)!;
    const t = monthTotals[d.month];
    planted.push({
      id: 6,
      slug: "dodo-payout-short-by-unrecorded-dispute",
      description: `The ${MONTH_NAMES[d.month - 1]} Dodo payout ${payout.reference} is short by a lost dispute that was never recorded in the ledger. payments - refunds - fees for the month does not equal the payout; the difference is exactly the dispute amount.`,
      records: {
        dodo_transactions: { payout_id: payout.id, payout_reference: payout.reference, dispute_id: d.id, dispute_reference: d.reference, disputed_payment_reference: d.paymentRef, month: d.month },
        bank_transactions: { ids: bankFor((b) => b.reference === payout.reference).map((b) => b.id) },
        ledger_entries: { expected_source: { source_type: "dodo", source_id: d.id }, found: [] },
      },
      amounts: {
        payments: usd(t.payments),
        refunds: usd(t.refunds),
        fees: usd(t.fees),
        expected_payout: usd(t.payments - t.refunds - t.fees),
        actual_payout: usd(payout.amount),
        dispute: usd(d.amount),
      },
    });
  }
  {
    const i = inv(PLANT.afterContract);
    const c = contracts[i.vendorId - 1];
    planted.push({
      id: 7,
      slug: "invoice-after-contract-end",
      description: `Invoice ${i.invoiceNumber} is dated ${i.issueDate}, after its contract ended on ${c.effectiveTo}. It was approved and paid.`,
      records: {
        invoices: { ids: [i.id], invoice_number: i.invoiceNumber, issue_date: i.issueDate },
        contracts: { ids: [c.id], effective_to: c.effectiveTo },
      },
      amounts: { invoice: usd(i.amount) },
    });
  }
  {
    const rows = ledgerFor((l) => l.sourceType === "adjustment");
    planted.push({
      id: 8,
      slug: "ledger-entry-without-bank-transaction",
      description: `Ledger entry "${rows[0].memo}" on ${rows[0].date} credits Cash with no matching bank transaction on any date.`,
      records: {
        ledger_entries: { ids: rows.map((l) => l.id), source_type: "adjustment", date: rows[0].date, memo: rows[0].memo },
        bank_transactions: { found: [] },
      },
      amounts: { entry: usd(rows[0].debit) },
    });
  }
  {
    const b = bankFor((x) => x.kind === "unknown_wire")[0];
    planted.push({
      id: 9,
      slug: "bank-payment-to-unknown-counterparty",
      description: `Bank wire ${b.reference} on ${b.date} to "${b.counterparty}" is over $5,000 and the counterparty is not a vendor, payroll, or Dodo. It was booked to ${ACCOUNTS.consulting}.`,
      records: {
        bank_transactions: { ids: [b.id], reference: b.reference, counterparty: b.counterparty, date: b.date },
        ledger_entries: { ids: ledgerFor((l) => l.sourceType === "bank" && l.sourceId === b.id).map((l) => l.id) },
      },
      amounts: { payment: usd(-b.amount) },
    });
  }
  {
    const extra = inv(PLANT.duplicateMonth.number);
    const base = inv(`${PLANT.duplicateMonth.vendor}-${YEAR}-${String(PLANT.duplicateMonth.month).padStart(2, "0")}`);
    planted.push({
      id: 10,
      slug: "two-invoices-same-vendor-same-month",
      description: `${VENDOR_DEFS[extra.vendorId - 1].name} issued two invoices in ${MONTH_NAMES[extra.issueDate ? monthOf(extra.issueDate) - 1 : 0]} ${YEAR} for a monthly service: ${base.invoiceNumber} and ${extra.invoiceNumber}. Both were approved and paid. The planted record is the second one.`,
      records: {
        invoices: { ids: [extra.id], invoice_number: extra.invoiceNumber, issue_date: extra.issueDate, sibling_invoice: { id: base.id, invoice_number: base.invoiceNumber } },
        bank_transactions: { ids: bankFor((b) => b.reference === extra.invoiceNumber).map((b) => b.id) },
      },
      amounts: { each_invoice: usd(extra.amount), double_billed: usd(extra.amount) },
    });
  }

  return { vendors, contracts, invoices, bank, dodo, ledger, pdfs, planted };
}

// ---------- helpers ----------

function cmp(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function linesToText(lines: PdfLine[]): string {
  return lines
    .map((l) => {
      switch (l.kind) {
        case "title":
        case "heading":
        case "text":
          return l.text;
        case "kv":
          return `${l.key}: ${l.value}`;
        case "gap":
          return "";
      }
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function contractLines(v: VendorDef, contractId: number): PdfLine[] {
  const ref = `${v.code}-CTR-${YEAR}-${String(contractId).padStart(3, "0")}`;
  return [
    { kind: "title", text: "SERVICES AGREEMENT" },
    { kind: "kv", key: "Contract reference", value: ref },
    { kind: "kv", key: "Provider", value: v.name },
    { kind: "kv", key: "Provider address", value: v.address },
    { kind: "kv", key: "Client", value: COMPANY },
    { kind: "kv", key: "Client address", value: "400 Summer Street, Floor 4, Boston, MA 02210" },
    { kind: "gap" },
    { kind: "heading", text: "1. Services" },
    { kind: "text", text: `${v.name} ("Provider") agrees to supply ${v.service} to ${COMPANY} ("Client") as described in this agreement: ${v.item}.` },
    { kind: "heading", text: "2. Fees" },
    { kind: "kv", key: "Monthly rate", value: usd(v.rate) },
    { kind: "text", text: `Client shall pay Provider a fixed monthly fee of ${usd(v.rate)}, invoiced on the first day of each calendar month for that month. Each month is invoiced exactly once. No other fees, surcharges, or rate changes apply during the term unless agreed in a signed amendment.` },
    { kind: "heading", text: "3. Term" },
    { kind: "kv", key: "Effective from", value: longDate(v.effectiveFrom) },
    { kind: "kv", key: "Effective to", value: longDate(v.effectiveTo) },
    { kind: "text", text: `This agreement is effective from ${longDate(v.effectiveFrom)} through ${longDate(v.effectiveTo)} inclusive. Services and billing end on the effective-to date. Any invoice dated after that date is outside this agreement.` },
    { kind: "heading", text: "4. Payment terms" },
    { kind: "text", text: "Invoices are due 30 days from the issue date (net 30) by ACH transfer referencing the invoice number. Client's internal policy requires every invoice to be approved by an authorised approver before payment, and invoices above $10,000 must be approved by the CFO." },
    { kind: "heading", text: "5. Signatures" },
    { kind: "kv", key: "For Provider", value: "Authorised signatory" },
    { kind: "kv", key: "For Client", value: "Priya Natarajan, CFO" },
  ];
}

function makeInvoice(
  id: number,
  vendorId: number,
  def: VendorDef,
  number: string,
  issueDate: string,
  amount: number,
  approvedBy: string | null,
  pdfs: PdfFile[],
): InvoiceRow {
  const dueDate = addDays(issueDate, 30);
  const filePath = `data/invoices/${number}.pdf`;
  const month = MONTH_NAMES[monthOf(issueDate) - 1];
  const contractRef = `${def.code}-CTR-${YEAR}-${String(vendorId).padStart(3, "0")}`;
  const lines: PdfLine[] = [
    { kind: "title", text: "INVOICE" },
    { kind: "kv", key: "Vendor", value: def.name },
    { kind: "kv", key: "Vendor address", value: def.address },
    { kind: "kv", key: "Bill to", value: COMPANY },
    { kind: "gap" },
    { kind: "kv", key: "Invoice number", value: number },
    { kind: "kv", key: "Issue date", value: longDate(issueDate) },
    { kind: "kv", key: "Due date", value: `${longDate(dueDate)} (net 30)` },
    { kind: "kv", key: "Contract", value: contractRef },
    { kind: "gap" },
    { kind: "heading", text: "Line items" },
    { kind: "kv", key: "1.", value: `${def.item}, ${month} ${YEAR}` },
    { kind: "kv", key: "Line amount", value: usd(amount) },
    { kind: "gap" },
    { kind: "kv", key: "Total due", value: usd(amount) },
    { kind: "gap" },
    { kind: "heading", text: "Approval" },
    approvedBy
      ? { kind: "text", text: `Approved for payment by ${approvedBy} on ${longDate(addDays(issueDate, 2))}.` }
      : { kind: "text", text: "Approval: NOT APPROVED. No approver recorded." },
    { kind: "gap" },
    { kind: "text", text: `Please remit by ACH referencing ${number}.` },
  ];
  pdfs.push({ path: filePath, lines });
  return { id, vendorId, invoiceNumber: number, issueDate, dueDate, amount, status: "paid", approvedBy, filePath };
}

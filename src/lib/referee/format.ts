// Money formatting, kept apart from data.ts so a client component can use it
// without pulling the database module into the browser bundle.

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatMoney(value: string | number): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n < 0 ? `-${MONEY.format(Math.abs(n))}` : MONEY.format(n);
}

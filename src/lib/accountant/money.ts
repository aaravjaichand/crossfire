// Money arrives from Drizzle as numeric(12,2) strings. Compare in integer cents
// so 9200.00 never fails an equality test through a float.

export function toCents(value: string | number): number {
  const str = String(value).trim();
  const neg = str.startsWith("-");
  const [whole, frac = ""] = str.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -cents : cents;
}

export function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** Dodo Payments fee: 4% of the payment + $0.40, charged on payments only. */
export function dodoFeeCents(amountCents: number): number {
  return Math.round(amountCents * 0.04) + 40;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function monthKey(date: string): string {
  return date.slice(0, 7);
}

export function monthOf(date: string): number {
  return Number(date.slice(5, 7));
}

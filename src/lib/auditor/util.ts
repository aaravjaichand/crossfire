// Small deterministic money/date helpers for the auditor module. Money
// columns come back from Drizzle as decimal strings; everything here works
// in integer cents to avoid floating-point drift.

export function toCents(amount: string): number {
  const neg = amount.startsWith("-");
  const clean = neg ? amount.slice(1) : amount;
  const [whole, frac = "0"] = clean.split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -cents : cents;
}

export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, "0")}`;
}

export function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10));
}

export function monthOf(date: string): number {
  return Number(date.slice(5, 7));
}

export function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

export function isMonthEnd(date: string, withinDays = 3): boolean {
  const dim = daysInMonth(yearOf(date), monthOf(date));
  return dayOfMonth(date) > dim - withinDays;
}

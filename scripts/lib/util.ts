// Small deterministic helpers shared by the seed and its self-check.

/** mulberry32: tiny seeded PRNG. Same seed => same sequence, always. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** float in [0, 1) */
  float() {
    return this.next();
  }
  /** integer in [min, max] inclusive */
  int(min: number, max: number) {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }
  /** weighted pick; weights need not sum to 1 */
  weighted<T>(items: readonly { value: T; weight: number }[]): T {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = this.next() * total;
    for (const it of items) {
      r -= it.weight;
      if (r <= 0) return it.value;
    }
    return items[items.length - 1].value;
  }
  token(len: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789") {
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[this.int(0, alphabet.length - 1)];
    return s;
  }
}

// ---- money: everything is integer cents until it hits the DB / a PDF ----

export function cents(c: number): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, "0")}`;
}

export function parseCents(s: string | number): number {
  const str = String(s);
  const neg = str.startsWith("-");
  const [w, f = ""] = str.replace("-", "").split(".");
  const v = Number(w) * 100 + Number((f + "00").slice(0, 2));
  return neg ? -v : v;
}

export function usd(c: number): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

// ---- dates: ISO yyyy-mm-dd strings, all UTC ----

export function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthOf(date: string): number {
  return Number(date.slice(5, 7));
}

export function lastDay(y: number, m: number): string {
  return iso(y, m, daysInMonth(y, m));
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

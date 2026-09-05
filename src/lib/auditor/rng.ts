// Tiny deterministic seeded PRNG (mulberry32). Same seed => same sequence,
// always. Used for weighted sampling without replacement in sampler.ts.

function mulberry32(seed: number) {
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
  float(): number {
    return this.next();
  }
}

/**
 * Weighted random sample of `count` distinct indices from `weights`,
 * without replacement, using the "weighted random sampling without
 * replacement" algorithm (Efraimidis-Spirakis): each candidate gets a key
 * `u^(1/weight)` for a fresh uniform `u`, and we take the top `count` keys.
 * Deterministic given the same Rng sequence and weights.
 */
export function weightedSampleIndices(rng: Rng, weights: number[], count: number): number[] {
  const keyed = weights.map((w, i) => {
    const u = Math.max(rng.float(), 1e-12);
    const weight = Math.max(w, 1e-9);
    return { i, key: Math.pow(u, 1 / weight) };
  });
  keyed.sort((a, b) => b.key - a.key);
  return keyed.slice(0, count).map((k) => k.i);
}

// Run inputs and their defaults. Kept out of start.ts because that file is a
// "use server" module, which may only export async functions.
import { CYCLES, parseCycles, type AuditCycle } from "@/lib/auditor/cycles";

// Re-exported so callers that already depend on the engine's inputs do not
// need a second import path for the cycle list. The list itself is defined in
// src/lib/auditor/cycles.ts, next to the sampler that applies it.
export { CYCLES, parseCycles, type AuditCycle };

/**
 * Above the largest single record in Northwind Labs' FY2025 books ($49,900),
 * so the default run is pure risk-weighted sampling and an existing seed
 * reproduces its picks exactly. Lower it to force 100% coverage of the items
 * above it.
 */
export const DEFAULT_MATERIALITY_CENTS = 5_000_000;
export const DEFAULT_SAMPLE_SIZE = 25;

export type StartRunInput = {
  name?: string;
  /** Materiality in cents. */
  materiality?: number;
  sampleSize?: number;
  cycles?: readonly string[];
  seed?: number;
};

export type StartedRun = {
  runId: number;
  /** Samples actually drawn; materiality can push this past `sampleSize`. */
  sampleCount: number;
  seed: number;
  materiality: number;
  sampleSize: number;
  cycles: AuditCycle[];
};

export type NormalizedInput = {
  name: string;
  seed: number;
  materiality: number;
  sampleSize: number;
  cycles: AuditCycle[];
};

/**
 * Fills in defaults for anything missing or nonsensical. A form field that
 * arrives empty, negative, or as NaN falls back to the default rather than
 * producing a run nobody can reproduce.
 */
export function normalizeRunInput(input: StartRunInput): NormalizedInput {
  const seed = Number.isFinite(input.seed) ? Math.trunc(input.seed as number) : 1;
  const materiality =
    Number.isFinite(input.materiality) && (input.materiality as number) > 0
      ? Math.round(input.materiality as number)
      : DEFAULT_MATERIALITY_CENTS;
  const sampleSize =
    Number.isFinite(input.sampleSize) && (input.sampleSize as number) > 0
      ? Math.trunc(input.sampleSize as number)
      : DEFAULT_SAMPLE_SIZE;
  const name = input.name?.trim() || `Audit run ${new Date().toISOString()}`;
  return { name, seed, materiality, sampleSize, cycles: parseCycles(input.cycles) };
}

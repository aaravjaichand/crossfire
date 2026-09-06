/**
 * The run engine: sampling and persistence (start.ts) plus the auditor /
 * accountant loop (run.ts) that takes every sample to defended or gap.
 */
export { prepareRun, startRun } from "./start";
export {
  DEFAULT_MATERIALITY_CENTS,
  DEFAULT_SAMPLE_SIZE,
  normalizeRunInput,
  type StartRunInput,
  type StartedRun,
} from "./inputs";
export {
  runAudit,
  MAX_CONCURRENCY,
  MAX_TURNS,
  type RunAuditOptions,
  type RunAuditResult,
  type SampleOutcome,
} from "./run";

/**
 * The run engine: sampling and persistence (start.ts) plus the auditor /
 * accountant loop (run.ts) that takes every sample to defended or gap.
 */
export { prepareRun, startRun } from "./start";
export {
  CYCLES,
  DEFAULT_MATERIALITY_CENTS,
  DEFAULT_SAMPLE_SIZE,
  normalizeRunInput,
  type AuditCycle,
  type StartRunInput,
  type StartedRun,
} from "./inputs";
export {
  runAudit,
  runAuditStep,
  CLAIM_LEASE_MS,
  MAX_CONCURRENCY,
  MAX_TURNS,
  STEP_BUDGET_MS,
  STEP_MAX_SAMPLES,
  type RunAuditOptions,
  type RunAuditResult,
  type RunStepOptions,
  type RunStepResult,
  type SampleOutcome,
} from "./run";

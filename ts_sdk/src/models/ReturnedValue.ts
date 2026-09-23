/**
 * What any call in the compute system answers — the TS mirror of
 * `flow_sdk/schema/data_spec/returned_value_spec.py`.
 *
 * One shape for a ComputeOp, a wizard, a command and an agent turn. A NESTED
 * answer (a wizard step's, a check's) carries `spec_kind` on the wire, so a
 * reader can tell a `CliResult` from a `PromptResult` without knowing what the
 * step called.
 */

/** Why a call ended. The values ARE `flow op`'s exit codes (2 is absent on purpose). */
export const ExitCode = {
  OK: 0,
  NOT_YET: 1,
  NOT_APPLICABLE: 3,
  NOT_FOUND: 4,
  REFUSED: 7,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Did the call reach its goal? The mirror of `ReturnedValue.ok` in Python:
 * OK and NOT_APPLICABLE are both "nothing to do here", and everything else is
 * not. Read this rather than re-deriving a verdict from `returncode` — that is
 * the process's own exit, not the answer's.
 */
export const isOk = (answer: Pick<ReturnedValue, 'exit_code'> | null | undefined): boolean =>
  answer?.exit_code === ExitCode.OK || answer?.exit_code === ExitCode.NOT_APPLICABLE;

export interface ReturnedValue {
  /** On a NESTED answer: `compute.returned`, `compute.returned.cli`, `.prompt`, `.ask`, `.wizard`. */
  spec_kind?: string;
  exit_code: ExitCode;
  value?: unknown;
  /** One sentence for a person. */
  detail?: string;
  /** False when nothing executed: the goal already held, or it never started,
   *  was busy, or was refused. */
  ran?: boolean;
  /** The wait ended before the work did — it may still be running. */
  timed_out?: boolean;
  /** Something else holds the slot this call needs — a wizard's lock, a turn
   *  in flight. The one NOT_YET worth retrying later; never-started is not busy. */
  busy?: boolean;
  duration_s?: number;
  /** Typed id of what ran it: `agentic_process-<id>` or `shell-<id>`. */
  executor?: string | null;
  /** The last completion-check run — the verdict's evidence. */
  check?: CliResult | null;
}

export interface CliResult extends ReturnedValue {
  /** As resolved for this platform. */
  command?: string;
  /** The raw process exit; `null` = it never started. `exit_code` is the verdict. */
  returncode?: number | null;
  stdout?: string;
  stderr?: string;
}

export interface PromptResult extends ReturnedValue {
  /** The full reply, beside the declared `value`. */
  text?: string;
}

export interface AskResult extends ReturnedValue {
  cancelled?: boolean;
}

export interface WizardResult extends ReturnedValue {
  /** Each step's own answer, by step id. A step never reached is absent. */
  steps?: Record<string, ReturnedValue & Partial<CliResult & PromptResult & AskResult & WizardResult>>;
}

/**
 * The `spec_kind` a NESTED answer (a wizard step's, a check's) carries on the
 * wire — the one way a reader tells which class it holds. Mirrors the
 * `spec_kind`s in `returned_value_spec.py`.
 */
export const ANSWER_KIND = {
  cli: 'compute.returned.cli',
  prompt: 'compute.returned.prompt',
  ask: 'compute.returned.ask',
  wizard: 'compute.returned.wizard',
} as const;

/** Is this answer a process record? Read from its kind — not inferred from
 *  whichever field happens to be present (`command` is empty on a record that
 *  never started, and a future answer class may carry one too). */
export const isCliResult = (answer: Pick<ReturnedValue, 'spec_kind'> | null | undefined): answer is CliResult =>
  answer?.spec_kind === ANSWER_KIND.cli;

/** Is this answer a nested wizard's own result? */
export const isWizardResult = (answer: Pick<ReturnedValue, 'spec_kind'> | null | undefined): answer is WizardResult =>
  answer?.spec_kind === ANSWER_KIND.wizard;

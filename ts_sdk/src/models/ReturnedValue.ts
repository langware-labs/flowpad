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

export interface ReturnedValue<T = unknown> {
  /** Answer kind on nested values and typed calls; older action roots may omit it. */
  spec_kind?: string;
  exit_code: ExitCode;
  value?: T | null;
  /** Explicit output presence. Legacy null without this field is ambiguous. */
  value_present?: boolean | null;
  /** Correlation for this invocation and its child observations; not an idempotency key. */
  invocation_id?: string | null;
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
  /** The callee gave its OWN account (an agent's receipt). With NOT_YET it tells "ran and says it
   *  could not" (true) from "the run itself broke" (false) — never read off the sentence. */
  reported?: boolean;
  duration_s?: number;
  /** Typed id of what ran it: `agentic_process-<id>` or `shell-<id>`. */
  executor?: string | null;
  /** The last completion-check run — the verdict's evidence. */
  check?: CliResult | null;
}

export interface ItemAnswer {
  index: number;
  key?: string | null;
  answer: ReturnedValue;
}

export interface CollectionResult<T = unknown> extends ReturnedValue<T[]> {
  /** Reached items in input order; failed batches never compact successful values. */
  items: ItemAnswer[];
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
  /** Files produced by a declared-output run, or selected for a channel reply. */
  files?: string[];
  /** The LLM endpoint that answered a `prompt` op (its TypeId): which model a logged call measured. */
  endpoint?: string | null;
}

export interface AskResult extends ReturnedValue {
  cancelled?: boolean;
}

/** Showing a place: delivery and usability are separate facts. */
export interface NavigateResult extends ReturnedValue {
  pointer?: string;
  connection_id?: string | null;
  delivered?: boolean;
  verdict?: string | null;
}

export interface WizardResult extends ReturnedValue {
  /** Each step's own answer, by step id. A step never reached is absent. */
  steps?: Record<string, ReturnedValue & Partial<CliResult & PromptResult & AskResult & NavigateResult & WizardResult & DecisionVerdict>>;
  /** The step whose `on_fail: stop` ended the run early; empty when none did. */
  stopped_at?: string;
}

/** What a `decision` op answered: did every requirement hold, and how sure. */
export interface DecisionVerdict extends ReturnedValue {
  met?: boolean;
  /** The deciding requirement's own probability — the least sure when several. */
  confidence?: number;
  /** The requirement that held, or the first that did not, in a sentence. */
  reason?: string;
  /** Every question's answer as the decision API gave it, by question name. */
  answers?: Record<string, { type: 'choice' | 'score' | 'yes_no'; [key: string]: unknown }>;
  /** The closed `DecisionError.reason` when the question could not be asked. */
  unavailable?: string | null;
  endpoint?: string;
  latency_ms?: number;
}

/** What the `smart-navigator` block answered: `value` is the `navigation.outcome`; the rest is how it
 *  was decided. Opening a dock and handing the request to the assistant are both OK. */
export interface NavigatorResult extends ReturnedValue {
  /** How it was decided (`rule`, `decision`) or why it was handed on (`unsure`, `no_endpoint`, ...). */
  reason?: string;
  latency_ms?: number;
  /** How it was decided, the model's request and response included when one was asked. */
  run?: { reason?: string; decision?: Record<string, unknown> | null } | null;
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
  decision: 'compute.returned.decision',
  navigator: 'compute.returned.navigator',
  navigate: 'compute.returned.navigate',
  collection: 'compute.returned.collection',
} as const;

export const isNavigateResult = (answer: Pick<ReturnedValue, 'spec_kind'> | null | undefined): answer is NavigateResult =>
  answer?.spec_kind === ANSWER_KIND.navigate;

/** Is this answer a process record? Read from its kind — not inferred from
 *  whichever field happens to be present (`command` is empty on a record that
 *  never started, and a future answer class may carry one too). */
export const isCliResult = (answer: Pick<ReturnedValue, 'spec_kind'> | null | undefined): answer is CliResult =>
  answer?.spec_kind === ANSWER_KIND.cli;

/** Is this answer a decision op's verdict? */
export const isDecisionVerdict = (
  answer: Pick<ReturnedValue, 'spec_kind'> | null | undefined,
): answer is DecisionVerdict => answer?.spec_kind === ANSWER_KIND.decision;

/** Is this answer a nested wizard's own result? */
export const isWizardResult = (answer: Pick<ReturnedValue, 'spec_kind'> | null | undefined): answer is WizardResult =>
  answer?.spec_kind === ANSWER_KIND.wizard;

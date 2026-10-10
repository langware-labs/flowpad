/**
 * The Automations screen's shapes — mirrors of `flow_sdk/schema/data_spec/automation_spec.py`.
 *
 * Every value the `Trigger` automation actions answer is one of these. The
 * sentence parts are structured so each surface renders them in its own
 * language; `text` is the backend's English rendering, for fallbacks only.
 */

import type { DecisionVerdict } from '../models/ReturnedValue';

export type AutomationKind = 'schedule' | 'event' | 'file' | 'agent_hook';
export type AutomationGroup = 'project' | 'mine' | 'builtin';
export type RunStatus = 'running' | 'launched' | 'succeeded' | 'failed' | 'skipped';
/** Why a fire did not happen. The two `decision_*` codes are the gate's (docs/snippets/stream-inbox-automations.md). */
export type ReasonCode =
  | 'storm'
  | 'confirm_failed'
  | 'disabled'
  | 'self_loop'
  | 'already_fired'
  | 'decision_no'
  | 'decision_unavailable';
export type SchedulePreset = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'every' | 'once' | 'cron';
export type ThenKind = 'run_agent' | 'run_script' | 'open_wizard' | 'builtin_step' | 'notify' | 'workflow' | 'nothing';

export interface ScheduleWhen {
  preset: SchedulePreset;
  expr: string;
  sched_type: 'cron' | 'interval' | 'date' | string;
  time?: string | null;
  /** 0 = Sunday … 6 = Saturday. */
  weekday?: number | null;
  month_day?: number | null;
  interval_seconds?: number | null;
  timezone?: string | null;
}

export interface EventWhen {
  pattern: string;
  title: string;
  description: string;
  target?: string | null;
}

export interface FileWhen {
  path: string;
  glob?: string | null;
  recursive: boolean;
  /** The path is a folder (browse it) rather than one file (open it). */
  is_folder?: boolean;
}

export interface HookWhen {
  events: string[];
}

export interface WhenPart {
  kind: AutomationKind;
  text: string;
  schedule?: ScheduleWhen | null;
  event?: EventWhen | null;
  file?: FileWhen | null;
  hook?: HookWhen | null;
}

export interface ThenPart {
  kind: ThenKind;
  text: string;
  target?: string | null;
  target_name?: string | null;
  prompt?: string | null;
  /** What a built-in step does, in words. */
  detail?: string | null;
  /** The step cannot run as configured; says why. */
  problem?: string | null;
}

export interface AutomationRun {
  id: string;
  trigger_id?: string | null;
  automation_name: string;
  kind?: AutomationKind | null;
  ts: string;
  status: RunStatus;
  is_test: boolean;
  why: string;
  reason_code?: ReasonCode | null;
  error?: string | null;
  duration_ms?: number | null;
  agentic_process_id?: string | null;
  process_status?: string | null;
  event_id?: string | null;
  cause_event_id?: string | null;
  cause_tag?: string | null;
  cause_target?: string | null;
  cause_data?: unknown;
  changed_path?: string | null;
  changes_total?: number | null;
  actions: string[];
  spec_hash?: string | null;
  /** What the rule's `if` decided — never the state. */
  decision?: GateDecision | null;
  /** The id of what it decided about (a stream inbox message's id); the state is rebuilt from it. */
  subject_id?: string | null;
  /** How the `then` wizard ended, step by step — outcomes only, never a step's output. */
  wizard?: WizardOutcome | null;
}

/** A `then` wizard's outcome as a run row keeps it (`WizardResult.outline`): the verdict and, by step id,
 *  each step's exit code, a short detail and the session it started — never a step's output. */
export interface WizardOutcome {
  exit_code: number;
  detail: string;
  stopped_at?: string;
  steps: Record<string, { exit_code: number; detail: string; executor?: string }>;
}

/** One execution mark on a list row: when, how it ended, and the session it opens. */
export interface RunMark {
  id: string;
  ts: string;
  status: RunStatus;
  agentic_process_id?: string | null;
}

/** The gate's decision as a run row keeps it (`tag_triggers.GateOutcome.row`). */
export interface GateDecision {
  caught: boolean;
  confidence: number;
  reason: string;
  answers: Record<string, unknown>;
  unavailable?: string | null;
  endpoint?: string | null;
  latency_ms?: number;
}

/** One row of the try list (`decide_on_recent`): a recent state and what the gate says of it. */
export interface TryRow {
  state: Record<string, unknown> & { message_id?: string; sender?: string; subject?: string; text?: string };
  /** What the gate says: asked now, or read from the log of a real run (`decided_at`). `met` either way. */
  verdict: Partial<DecisionVerdict>;
  /** Set when the verdict came from a real run's log — no call was made. */
  decided_at?: string | null;
  agentic_process_id?: string | null;
}

export interface AutomationSummary {
  id: string;
  name: string;
  description: string;
  kind: AutomationKind;
  group: AutomationGroup;
  project_id?: string | null;
  enabled: boolean;
  when: WhenPart;
  then: ThenPart[];
  last_run?: AutomationRun | null;
  recent_failures: number;
  recent_runs: number;
  /** The last five real runs, newest first — the row's execution marks. */
  last_runs: RunMark[];
  /** Fires the gate declined. */
  passed_over: number;
  next_run?: string | null;
  fires: number;
  tested: boolean;
  read_only: boolean;
  asset_ref?: string | null;
}

/** What *Run once now* answers. The run continues in the background unless `background` is false. */
export interface RunOnceStarted {
  trigger_id: string;
  event_id?: string | null;
  background: boolean;
  error?: string | null;
  detail: Record<string, unknown>;
}

export interface NextRuns {
  times: string[];
  schedule: ScheduleWhen;
  text: string;
}

/** An event a test runs with: a recent real one from the bus, or a stored run's cause. */
export interface AutomationTestEvent {
  tag: string;
  target?: string | null;
  data?: Record<string, unknown> | null;
}

export interface RunsQuery {
  triggerId?: string | null;
  status?: RunStatus | null;
  includeTests?: boolean;
  /** Rows the gate declined (`decision_no` / `decision_unavailable`); default false. */
  includeDeclined?: boolean;
  /** Flowpad's own automations' runs (default true). */
  includeBuiltin?: boolean;
  limit?: number;
}

/** One thing *Check* found. `area`: when | event | then | state. */
export interface CheckFinding {
  area: 'when' | 'event' | 'then' | 'state' | string;
  ok: boolean;
  message: string;
}

/** What *Check* answers — "would it run, and what would it do" — with no side effects. */
export interface AutomationCheck {
  ok: boolean;
  /** For an event automation checked against an event: would that event start it. */
  would_fire?: boolean | null;
  findings: CheckFinding[];
  when?: WhenPart | null;
  then: ThenPart[];
  next_runs: string[];
}

/** A recent real event an automation could be tested with. */
export interface AutomationSample {
  id?: string | null;
  ts?: string | null;
  tag: string;
  target: string;
  data: Record<string, unknown>;
}

export interface PatternMatch {
  matches: boolean;
  parts: { tag: boolean; target: boolean; scope: boolean };
  problem?: string | null;
}

export interface BusListener {
  id: string;
  name: string;
  pattern: string;
  enabled: boolean;
  group: AutomationGroup;
  /** False for a copy from another install — listed, never armed. */
  active: boolean;
  then: ThenPart[];
}

export interface BusEventType {
  name: string;
  title: string;
  description: string;
  family: boolean;
  /** A listener's pattern no event has matched yet. */
  pattern_only: boolean;
  count: number;
  last_ts?: string | null;
  last_target?: string | null;
  /** Reaches the app's live stream. */
  forwarded: boolean;
  listeners: BusListener[];
}

export interface BusMap {
  event_types: BusEventType[];
  forwarded_patterns: string[];
}

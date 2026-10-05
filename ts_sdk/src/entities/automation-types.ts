/**
 * The Automations screen's shapes — mirrors of `flow_sdk/schema/data_spec/automation_spec.py`.
 *
 * Every value the `Trigger` automation actions answer is one of these. The
 * sentence parts are structured so each surface renders them in its own
 * language; `text` is the backend's English rendering, for fallbacks only.
 */

export type AutomationKind = 'schedule' | 'event' | 'file' | 'agent_hook';
export type AutomationGroup = 'project' | 'mine' | 'builtin';
export type RunStatus = 'running' | 'launched' | 'succeeded' | 'failed' | 'skipped';
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
  reason_code?: string | null;
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

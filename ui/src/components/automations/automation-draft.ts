/**
 * The builder's working copy of an automation — "When … (only if) … Then …" as
 * form state, and its translation to and from Trigger fields.
 *
 * Pure (no React, no SDK calls) so every preset round-trips under unit test:
 * a schedule chosen as "Every weekday at 09:00" saves as `0 9 * * 1-5` and
 * reads back as the same preset (the backend's `read_schedule` is the inverse).
 */
import type { AutomationKind, ITrigger, ScheduleWhen, SchedulePreset, TriggerActionRow } from '@sdk';
import { toLocalInputValue } from '@src/components/cron-view/CronForm';

export type EveryUnit = 'minutes' | 'hours' | 'days';
export type ThenChoice = 'run_agent' | 'run_script' | 'notify' | 'keep';

export interface ScheduleDraft {
  preset: SchedulePreset;
  /** HH:MM, for the time-of-day presets. */
  time: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  monthDay: number;
  everyN: number;
  everyUnit: EveryUnit;
  /** `YYYY-MM-DDTHH:MM`, local wall clock. */
  onceAt: string;
  cron: string;
  /** IANA zone; empty = this machine's. */
  timezone: string;
}

export interface AutomationDraft {
  kind: AutomationKind;
  name: string;
  enabled: boolean;
  schedule: ScheduleDraft;
  event: { pattern: string; target: string };
  file: { path: string; glob: string; recursive: boolean };
  hook: { events: string[] };
  then: {
    choice: ThenChoice;
    /** `agent-<uuid>`, for run_agent. */
    agentTypeId: string;
    prompt: string;
    scriptPath: string;
  };
  /** Steps the builder cannot edit (a built-in callback, a wizard) — kept as they are. */
  keptActions: TriggerActionRow[];
  advanced: { fireOnce: boolean; maxFiresPerMinute: number | null };
}

function defaultSchedule(): ScheduleDraft {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const onceAt = toLocalInputValue(tomorrow).slice(0, 16);
  return {
    preset: 'weekdays',
    time: '09:00',
    weekday: 1,
    monthDay: 1,
    everyN: 30,
    everyUnit: 'minutes',
    onceAt,
    cron: '0 9 * * 1-5',
    timezone: '',
  };
}

export function defaultDraft(kind: AutomationKind): AutomationDraft {
  return {
    kind,
    name: '',
    enabled: true,
    schedule: defaultSchedule(),
    event: { pattern: '', target: '' },
    file: { path: '', glob: '', recursive: false },
    hook: { events: [] },
    then: { choice: 'run_agent', agentTypeId: '', prompt: '', scriptPath: '' },
    keptActions: [],
    advanced: { fireOnce: false, maxFiresPerMinute: null },
  };
}

/** A schedule draft as the trigger's `{expr, sched_trigger_type}`. */
export function scheduleExpr(s: ScheduleDraft): { expr: string; sched_trigger_type: 'cron' | 'interval' | 'date' } {
  const [h, m] = (s.time || '09:00').split(':').map((x) => Number(x) || 0);
  switch (s.preset) {
    case 'daily':
      return { expr: `${m} ${h} * * *`, sched_trigger_type: 'cron' };
    case 'weekdays':
      return { expr: `${m} ${h} * * 1-5`, sched_trigger_type: 'cron' };
    case 'weekly':
      return { expr: `${m} ${h} * * ${s.weekday}`, sched_trigger_type: 'cron' };
    case 'monthly':
      return { expr: `${m} ${h} ${s.monthDay} * *`, sched_trigger_type: 'cron' };
    case 'every': {
      const unit = s.everyUnit === 'days' ? 'd' : s.everyUnit === 'hours' ? 'h' : 'm';
      return { expr: `${Math.max(1, Math.floor(s.everyN || 1))}${unit}`, sched_trigger_type: 'interval' };
    }
    case 'once':
      return { expr: s.onceAt.length === 16 ? `${s.onceAt}:00` : s.onceAt, sched_trigger_type: 'date' };
    default:
      return { expr: s.cron.trim(), sched_trigger_type: 'cron' };
  }
}

/** The backend's reading of a saved schedule, as a draft (the inverse of `scheduleExpr`). */
export function scheduleFromWhen(w: ScheduleWhen): ScheduleDraft {
  const base = defaultSchedule();
  const draft: ScheduleDraft = { ...base, preset: w.preset, cron: w.expr, timezone: w.timezone ?? '' };
  if (w.time) draft.time = w.time;
  if (w.weekday != null) draft.weekday = w.weekday;
  if (w.month_day != null) draft.monthDay = w.month_day;
  if (w.preset === 'every' && w.interval_seconds) {
    const s = w.interval_seconds;
    if (s % 86400 === 0) Object.assign(draft, { everyN: s / 86400, everyUnit: 'days' });
    else if (s % 3600 === 0) Object.assign(draft, { everyN: s / 3600, everyUnit: 'hours' });
    else Object.assign(draft, { everyN: Math.max(1, Math.round(s / 60)), everyUnit: 'minutes' });
  }
  if (w.preset === 'once') draft.onceAt = w.expr.slice(0, 16);
  return draft;
}

const TRIGGER_TYPE: Record<AutomationKind, ITrigger['trigger_type']> = {
  schedule: 'schedule',
  event: 'tag',
  file: 'fsop',
  agent_hook: 'hook',
};

function kindOfTriggerType(type: ITrigger['trigger_type'] | undefined): AutomationKind {
  return type === 'schedule' ? 'schedule' : type === 'tag' ? 'event' : type === 'fsop' ? 'file' : 'agent_hook';
}

/** The step the builder edits, as a row action — or none for "keep what is there". */
function editedAction(d: AutomationDraft): TriggerActionRow | null {
  switch (d.then.choice) {
    case 'run_agent':
      return { action_type: 'run_agent', target_type_id: d.then.agentTypeId || null, prompt: d.then.prompt.trim() };
    case 'run_script':
      return { action_type: 'run_script', script_path: d.then.scriptPath.trim() };
    case 'notify':
      return { action_type: 'notify_entity' };
    default:
      return null;
  }
}

/** The fields a draft saves as — for `Trigger.createAutomation` / `updateAutomation` / `checkSpec`. */
export function draftToFields(d: AutomationDraft): Partial<ITrigger> & { name: string } {
  const edited = editedAction(d);
  const fields: Partial<ITrigger> & { name: string } = {
    name: d.name.trim() || autoName(d),
    trigger_type: TRIGGER_TYPE[d.kind],
    enabled: d.enabled,
    actions: [...(edited ? [edited] : []), ...d.keptActions],
    fire_once: d.advanced.fireOnce,
  };
  if (d.advanced.maxFiresPerMinute) fields.max_fires_per_minute = d.advanced.maxFiresPerMinute;
  if (d.kind === 'schedule') {
    Object.assign(fields, scheduleExpr(d.schedule), { timezone: d.schedule.timezone || null });
  } else if (d.kind === 'event') {
    Object.assign(fields, { tag_pattern: d.event.pattern.trim(), tag_target: d.event.target.trim() || undefined });
  } else if (d.kind === 'file') {
    Object.assign(fields, {
      watch_path: d.file.path.trim(),
      watch_glob: d.file.glob.trim() || undefined,
      recursive: d.file.recursive,
    });
  } else {
    fields.hook_events = d.hook.events;
  }
  return fields;
}

/** A name when the person gave none: the kind and its subject. */
function autoName(d: AutomationDraft): string {
  if (d.kind === 'schedule') return `Scheduled ${d.then.choice === 'run_script' ? 'script' : 'run'}`;
  if (d.kind === 'event') return `On ${d.event.pattern || 'an event'}`;
  if (d.kind === 'file') return `On change in ${d.file.path.split('/').pop() || 'a folder'}`;
  return 'On agent activity';
}

/** An existing automation (its Trigger row + the backend's schedule reading) as a draft. */
export function draftFromTrigger(t: ITrigger, schedule?: ScheduleWhen | null): AutomationDraft {
  const kind = kindOfTriggerType(t.trigger_type);
  const d = defaultDraft(kind);
  d.name = t.name ?? '';
  d.enabled = t.enabled ?? true;
  if (kind === 'schedule' && schedule) d.schedule = scheduleFromWhen(schedule);
  d.event = { pattern: t.tag_pattern ?? '', target: t.tag_target ?? '' };
  d.file = { path: t.watch_path ?? '', glob: t.watch_glob ?? '', recursive: !!t.recursive };
  d.hook = { events: [...(t.hook_events ?? [])] };
  d.advanced = { fireOnce: !!t.fire_once, maxFiresPerMinute: t.max_fires_per_minute ?? null };

  const actions = [...(t.actions ?? [])];
  // The first editable step becomes the "Then"; everything else is kept untouched.
  const index = actions.findIndex((a) => ['run_agent', 'run_script', 'notify_entity'].includes(a.action_type));
  if (index >= 0) {
    const a = actions.splice(index, 1)[0];
    d.then =
      a.action_type === 'run_agent'
        ? { choice: 'run_agent', agentTypeId: a.target_type_id ?? '', prompt: a.prompt ?? '', scriptPath: '' }
        : a.action_type === 'run_script'
          ? { choice: 'run_script', agentTypeId: '', prompt: '', scriptPath: a.script_path ?? a.script_filename ?? '' }
          : { choice: 'notify', agentTypeId: '', prompt: '', scriptPath: '' };
  } else {
    d.then = { ...d.then, choice: actions.length ? 'keep' : 'run_agent' };
  }
  d.keptActions = actions;
  return d;
}

/** Something missing before a draft can be saved; the UI words each. */
export type DraftProblem = 'pattern' | 'path' | 'agent' | 'prompt' | 'script' | 'cron' | 'events';

/** What is missing before the draft can be saved. */
export function draftProblems(d: AutomationDraft): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (d.kind === 'event' && !d.event.pattern.trim()) out.push('pattern');
  if (d.kind === 'file' && !d.file.path.trim()) out.push('path');
  if (d.kind === 'schedule' && d.schedule.preset === 'cron' && d.schedule.cron.trim().split(/\s+/).length !== 5)
    out.push('cron');
  if (d.kind === 'agent_hook' && d.hook.events.length === 0) out.push('events');
  if (d.then.choice === 'run_agent') {
    if (!d.then.agentTypeId) out.push('agent');
    if (!d.then.prompt.trim()) out.push('prompt');
  }
  if (d.then.choice === 'run_script' && !d.then.scriptPath.trim()) out.push('script');
  return out;
}

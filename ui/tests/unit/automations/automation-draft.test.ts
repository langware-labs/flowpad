/**
 * The builder's form state ↔ Trigger fields. Every preset must save as the
 * expression the backend reads back as the same preset (automations/schedule.py).
 */
import { describe, expect, it } from 'vitest';
import type { ITrigger, ScheduleWhen } from '@sdk';
import {
  defaultDraft,
  draftFromTrigger,
  draftProblems,
  draftToFields,
  scheduleExpr,
  scheduleFromWhen,
  type ScheduleDraft,
} from '@src/components/automations/automation-draft';
import { AUTOMATION_RECIPES, recipeById } from '@src/components/automations/automation-recipes';

const sched = (patch: Partial<ScheduleDraft>): ScheduleDraft => ({ ...defaultDraft('schedule').schedule, ...patch });

describe('schedule presets → expression', () => {
  it.each([
    [{ preset: 'daily', time: '07:30' }, '30 7 * * *', 'cron'],
    [{ preset: 'weekdays', time: '09:00' }, '0 9 * * 1-5', 'cron'],
    [{ preset: 'weekly', time: '09:00', weekday: 1 }, '0 9 * * 1', 'cron'],
    [{ preset: 'monthly', time: '06:15', monthDay: 1 }, '15 6 1 * *', 'cron'],
    [{ preset: 'every', everyN: 30, everyUnit: 'minutes' }, '30m', 'interval'],
    [{ preset: 'every', everyN: 2, everyUnit: 'hours' }, '2h', 'interval'],
    [{ preset: 'once', onceAt: '2026-10-06T09:00' }, '2026-10-06T09:00:00', 'date'],
    [{ preset: 'cron', cron: ' */5 * * * * ' }, '*/5 * * * *', 'cron'],
  ] as const)('%o → %s', (patch, expr, kind) => {
    expect(scheduleExpr(sched(patch as Partial<ScheduleDraft>))).toEqual({ expr, sched_trigger_type: kind });
  });

  it('reads the backend reading back into the same preset', () => {
    const when: ScheduleWhen = {
      preset: 'weekly',
      expr: '0 9 * * 1',
      sched_type: 'cron',
      time: '09:00',
      weekday: 1,
      timezone: 'UTC',
    };
    const draft = scheduleFromWhen(when);
    expect(draft).toMatchObject({ preset: 'weekly', time: '09:00', weekday: 1, timezone: 'UTC' });
    expect(scheduleExpr(draft).expr).toBe('0 9 * * 1');
  });

  it('turns an interval back into the largest whole unit', () => {
    expect(
      scheduleFromWhen({ preset: 'every', expr: '2h', sched_type: 'interval', interval_seconds: 7200 }),
    ).toMatchObject({ everyN: 2, everyUnit: 'hours' });
  });
});

describe('draft → fields', () => {
  it('saves a schedule that runs an agent', () => {
    const d = defaultDraft('schedule');
    d.then = { choice: 'run_agent', agentTypeId: 'agent-1', prompt: ' Go ', scriptPath: '' };
    expect(draftToFields(d)).toMatchObject({
      trigger_type: 'schedule',
      expr: '0 9 * * 1-5',
      sched_trigger_type: 'cron',
      actions: [{ action_type: 'run_agent', target_type_id: 'agent-1', prompt: 'Go' }],
    });
  });

  it('maps each kind to its trigger type and fields', () => {
    const event = { ...defaultDraft('event'), event: { pattern: 'task.*', target: 'task:*' } };
    expect(draftToFields(event)).toMatchObject({ trigger_type: 'tag', tag_pattern: 'task.*', tag_target: 'task:*' });
    const file = { ...defaultDraft('file'), file: { path: '/w', glob: '*.md', recursive: true } };
    expect(draftToFields(file)).toMatchObject({
      trigger_type: 'fsop',
      watch_path: '/w',
      watch_glob: '*.md',
      recursive: true,
    });
  });

  it('makes up a name when none is given', () => {
    const d = { ...defaultDraft('event'), event: { pattern: 'app.ready', target: '' } };
    expect(draftToFields(d).name).toBe('On app.ready');
  });
});

describe('trigger → draft', () => {
  it('edits the first editable step and keeps the rest untouched', () => {
    const t: Partial<ITrigger> = {
      name: 'LLM setup',
      trigger_type: 'tag',
      tag_pattern: 'app.tab.ready',
      actions: [
        { action_type: 'callback', callback_name: 'builtin_run_llm_setup' },
        { action_type: 'run_agent', target_type_id: 'agent-9', prompt: 'Hi' },
      ],
    };
    const d = draftFromTrigger(t as ITrigger);
    expect(d.kind).toBe('event');
    expect(d.then).toMatchObject({ choice: 'run_agent', agentTypeId: 'agent-9', prompt: 'Hi' });
    expect(d.keptActions).toEqual([{ action_type: 'callback', callback_name: 'builtin_run_llm_setup' }]);
    // Saving puts the edited step first and keeps the callback.
    expect(draftToFields(d).actions?.map((a) => a.action_type)).toEqual(['run_agent', 'callback']);
  });

  it('a rule with only built-in steps keeps them', () => {
    const d = draftFromTrigger({
      name: 'x',
      trigger_type: 'tag',
      actions: [{ action_type: 'callback', callback_name: 'c' }],
    } as ITrigger);
    expect(d.then.choice).toBe('keep');
    expect(draftToFields(d).actions).toEqual([{ action_type: 'callback', callback_name: 'c' }]);
  });
});

describe('what is missing', () => {
  it('names each missing piece', () => {
    const d = defaultDraft('event');
    expect(draftProblems(d)).toEqual(['pattern', 'agent', 'prompt']);
    d.event.pattern = 'task.*';
    d.then = { choice: 'run_script', agentTypeId: '', prompt: '', scriptPath: '' };
    expect(draftProblems(d)).toEqual(['script']);
  });

  it('a custom cron needs five parts', () => {
    const d = defaultDraft('schedule');
    d.schedule = sched({ preset: 'cron', cron: '0 9 *' });
    d.then = { choice: 'run_script', agentTypeId: '', prompt: '', scriptPath: '/x.sh' };
    expect(draftProblems(d)).toEqual(['cron']);
  });
});

describe('recipes', () => {
  it('each starter is a draft of its own kind with the When filled', () => {
    for (const r of AUTOMATION_RECIPES) {
      const d = r.draft();
      expect(d.kind).toBe(r.kind);
      expect(d.name).not.toBe('');
      expect(d.then.prompt).not.toBe('');
    }
    expect(recipeById('morning-briefing')?.draft().schedule.preset).toBe('weekdays');
    expect(recipeById('nope')).toBeUndefined();
  });
});

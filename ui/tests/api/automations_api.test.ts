/**
 * Automations against a live backend, through the TS SDK only — the same door the
 * screen uses. One automation's whole life: made, checked, run once while off,
 * listed as tested, fired for real by an event, seen on the bus, switched off,
 * deleted.
 */
import { emitBusEvent, Trigger } from '@sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { errorMessage } from '@src/lib/error-message';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const signupInfo = getTestSignupInfo();

beforeEach(async (context: any) => {
  await apiTestSetup(signupInfo, context.task.name);
});

const uniq = () => Math.random().toString(36).slice(2, 8);

describe('an automation, end to end', () => {
  it('is made, checked, run once while off, fired for real, and removed', async () => {
    const tag = `apiauto${uniq()}`;
    const created = await Trigger.createAutomation({
      name: `API automation ${tag}`,
      trigger_type: 'tag',
      tag_pattern: `${tag}.*`,
      enabled: false,
    });
    try {
      // Listed as a sentence, not tested yet.
      const listed = (await Trigger.overview()).find((a) => a.id === created.id);
      expect(listed).toMatchObject({ kind: 'event', group: 'mine', enabled: false, tested: false });
      expect(listed?.when.event?.pattern).toBe(`${tag}.*`);

      // Check against an event: field by field, nothing runs.
      const hit = await Trigger.check(created.id, { tag: `${tag}.ping`, target: 'task:1' });
      expect(hit.would_fire).toBe(true);
      expect(hit.findings.some((f) => f.area === 'state' && /switched off/.test(f.message))).toBe(true);
      expect(await Trigger.runs({ triggerId: created.id })).toEqual([]);

      // Run once while off: it runs, as a test, and the list says it is tested.
      const started = await Trigger.runOnce(created.id, { tag: `${tag}.ping`, target: 'task:1', data: { n: 1 } });
      expect(started.event_id).toBeTruthy();
      await vi.waitFor(
        async () => {
          const runs = await Trigger.runs({ triggerId: created.id });
          expect(runs[0]).toMatchObject({ is_test: true, status: 'succeeded', cause_tag: `${tag}.ping` });
        },
        { timeout: 5_000, interval: 200 },
      );
      expect((await Trigger.overview()).find((a) => a.id === created.id)?.tested).toBe(true);

      // Switched on, a real event fires it.
      await Trigger.setEnabled(created.id, true);
      await emitBusEvent(`${tag}.real`, 'task:2', { n: 2 });
      await vi.waitFor(
        async () => {
          const real = (await Trigger.runs({ triggerId: created.id, includeTests: false }))[0];
          expect(real).toMatchObject({ is_test: false, cause_tag: `${tag}.real` });
        },
        { timeout: 5_000, interval: 200 },
      );

      // The bus lists it as a listener of what it heard.
      const seen = (await Trigger.busMap()).event_types.find((e) => e.name === `${tag}.real`);
      expect(seen?.listeners.map((l) => l.id)).toContain(created.id);
      expect(seen?.count).toBeGreaterThanOrEqual(1);
    } finally {
      await Trigger.remove(created.id);
    }
    expect((await Trigger.overview()).some((a) => a.id === created.id)).toBe(false);
  });

  it('checks an unsaved schedule and previews its runs', async () => {
    const check = await Trigger.checkSpec({ trigger_type: 'schedule', expr: '0 9 * * 1-5', sched_trigger_type: 'cron' });
    expect(check.when?.schedule?.preset).toBe('weekdays');
    expect(check.next_runs).toHaveLength(5);
    // Weekdays are weekdays: none of the next five falls on a weekend.
    const next = await Trigger.nextRuns({ expr: '0 9 * * 1-5', timezone: 'UTC' }, 10);
    expect(next.times.map((t) => new Date(t).getUTCDay()).every((d) => d >= 1 && d <= 5)).toBe(true);
  });

  it('refuses a bad schedule with words, not a 500', async () => {
    const error = await Trigger.createAutomation({ name: `bad ${uniq()}`, trigger_type: 'schedule', expr: 'nope' }).then(
      () => null,
      (e: unknown) => e,
    );
    // What the screen shows: the envelope's message, read the way every notice reads it.
    expect(errorMessage(error, '')).toMatch(/can't be read/);
    expect((error as { response?: { status?: number } })?.response?.status).toBe(422);
  });

  it('answers the pattern sandbox field by field', async () => {
    const result = await Trigger.matchPattern('task.*', { tag: 'task.done', target: 'project:1' }, 'task:*');
    expect(result).toMatchObject({ matches: false, parts: { tag: true, target: false } });
  });
});

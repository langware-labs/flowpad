/**
 * The `/launch?agent=` GA4 funnel — what lands in the GTM data layer.
 *
 * The param names are a wire contract with the GTM container (one Data Layer Variable per
 * name), so these tests pin the exact keys, and that every push carries all of them: the GTM
 * data model is cumulative, and a key left out would be read back from the previous push.
 */
import { elapsedBucket, LaunchTracker } from '@src/pages/entry/launch-analytics';
import { beforeEach, describe, expect, it } from 'vitest';

const PARAMS = [
  'agent_id',
  'signed_in',
  'method',
  'flow',
  'workflow_stage',
  'workflow_step_name',
  'workflow_step_index',
  'workflow_step_status',
  'workflow_step_duration_sec',
  'workflow_step_elapsed_sec',
  'elapsed_sec',
  'elapsed_bucket',
];

type Push = Record<string, unknown>;

function launchPushes(): Push[] {
  return (window.dataLayer as Push[]).filter((p) => String(p.event).startsWith('launch_'));
}

let clock = 0;
const tracker = () => new LaunchTracker('agent-1', () => clock);

beforeEach(() => {
  window.dataLayer = [];
  clock = 0;
});

describe('LaunchTracker', () => {
  it('every push carries every funnel param', () => {
    const t = tracker();
    t.view(false);
    t.signInStart();
    t.setupStart();
    t.step('launch', 1, 'started');
    for (const push of launchPushes()) {
      for (const key of PARAMS) expect(push, `${String(push.event)} is missing ${key}`).toHaveProperty(key);
    }
  });

  it('reports the funnel in order, with the stage each event happened in', () => {
    const t = tracker();
    t.view(false);
    t.signInStart();
    t.signInComplete();
    t.setupStart();
    t.setupComplete();
    t.enterMachine();
    expect(launchPushes().map((p) => [p.event, p.workflow_stage, p.signed_in])).toEqual([
      ['launch_view', 'landing', 'false'],
      ['launch_sign_in_start', 'sign_in', 'false'],
      ['launch_sign_in_complete', 'sign_in', 'true'],
      ['launch_setup_start', 'setup', 'true'],
      ['launch_setup_complete', 'setup_complete', 'true'],
      ['launch_enter_machine', 'entered', 'true'],
    ]);
    expect(launchPushes().every((p) => p.agent_id === 'agent-1' && p.flow === 'launch')).toBe(true);
  });

  it('times each step and the whole setup in seconds', () => {
    const t = tracker();
    t.setupStart();
    clock = 2_000;
    t.step('launch', 1, 'started');
    clock = 47_000;
    t.step('launch', 1, 'success');
    const done = launchPushes().at(-1)!;
    expect(done).toMatchObject({
      event: 'launch_setup_step',
      workflow_step_name: 'launch',
      workflow_step_index: 1,
      workflow_step_status: 'success',
      workflow_step_duration_sec: 45,
      elapsed_sec: 47,
      elapsed_bucket: '30-60s',
    });
  });

  it('a step whose start was never seen counts zero seconds', () => {
    const t = tracker();
    t.setupStart();
    clock = 5_000;
    t.step('open', 9, 'success');
    expect(launchPushes().at(-1)).toMatchObject({ workflow_step_duration_sec: 0, workflow_step_status: 'success' });
  });

  it('abandoning mid-step reports the step and how long it had been running', () => {
    const t = tracker();
    t.setupStart();
    clock = 10_000;
    t.step('clone', 4, 'started');
    clock = 95_000;
    t.abandon();
    expect(launchPushes().at(-1)).toMatchObject({
      event: 'launch_abandon',
      workflow_stage: 'setup',
      workflow_step_name: 'clone',
      workflow_step_status: 'abandoned',
      workflow_step_elapsed_sec: 85,
      elapsed_sec: 95,
      elapsed_bucket: '60-120s',
    });
  });

  it('does not report an abandon once the machine was entered, and never twice', () => {
    const entered = tracker();
    entered.enterMachine();
    entered.abandon();
    expect(launchPushes().some((p) => p.event === 'launch_abandon')).toBe(false);

    const left = tracker();
    left.view(false);
    left.abandon();
    left.abandon();
    expect(launchPushes().filter((p) => p.event === 'launch_abandon')).toHaveLength(1);
  });

  it('a failed setup names the step it failed in', () => {
    const t = tracker();
    t.setupStart();
    t.step('health', 2, 'started');
    clock = 30_000;
    t.setupError();
    expect(launchPushes().at(-1)).toMatchObject({
      event: 'launch_setup_error',
      workflow_stage: 'failed',
      workflow_step_name: 'health',
      workflow_step_status: 'error',
    });
  });

  it('a param that does not apply is cleared, not left over from the previous push', () => {
    const t = tracker();
    t.setupStart();
    t.step('launch', 1, 'started');
    t.setupComplete();
    const last = launchPushes().at(-1)!;
    expect(last.workflow_step_name).toBeUndefined();
    expect(last.workflow_step_index).toBeUndefined();
  });
});

describe('elapsedBucket', () => {
  it.each([
    [0, '0-15s'],
    [14.9, '0-15s'],
    [15, '15-30s'],
    [299, '120-300s'],
    [300, '300s+'],
    [3600, '300s+'],
  ])('%s s → %s', (sec, bucket) => {
    expect(elapsedBucket(sec)).toBe(bucket);
  });
});

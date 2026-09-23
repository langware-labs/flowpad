/**
 * Joining the two halves of "what is this run doing".
 *
 * Live (the Activity tree) and durable (`run.json`) are genuinely different
 * sources and neither subsumes the other: a trigger-fired run is instance-scoped
 * by design, so it produces NO live rows in this viewer, while a run in flight
 * has no durable record yet. Driven through the store's real ingestion point —
 * a hand-built store would not prove the children ever arrive.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityProgressSpec } from '@sdk/activity';

import { __resetActivityStoreForTest, handleActivitySnapshot } from '@src/store/activity-store';
import { stepStatus, useWizardRun } from '@src/components/assets/editor/wizard/useWizardRun';

/** Exit codes, spelled as the wire carries them. */
const OK = 0;
const NOT_YET = 1;

/** A `run_state` whose last run answered with these steps, in RUN order. */
function ran(steps: Record<string, Record<string, unknown>>) {
  return { result: { exit_code: OK, steps } };
}

const SUBJECT = 'wizard-11111111-1111-4111-8111-111111111111';

function node(over: Partial<ActivityProgressSpec> = {}): ActivityProgressSpec {
  return {
    activity_id: 'a1', subject_entity: SUBJECT, path: 'wizard-demo', name: 'wizard-demo',
    label: null, icon: null, state: 'running', current: null, message: null,
    done: 0, total: null, skipped: 0, errors_count: 0, errors: [], counters: {},
    children: [], started_at: null, updated_at: null, finished_at: null, seq: 1,
    ...over,
  };
}

function wizardDouble(runState: Record<string, unknown>, runDetail?: Record<string, unknown>) {
  return {
    activity_path: 'wizard-demo',
    typeId: { toString: () => SUBJECT },
    run_state: runState,
    runDetail: async () => runDetail ?? { result: null },
  } as never;
}

afterEach(() => __resetActivityStoreForTest());

describe('useWizardRun.join', () => {
  it('returns steps in DOCUMENT order, not in run order', () => {
    const wizard = wizardDouble(ran({ c: { exit_code: OK }, a: { exit_code: OK } }));
    const { result } = renderHook(() => useWizardRun(wizard));
    const { steps } = result.current.join(['a', 'b', 'c']);
    expect(steps.map((s) => s.step_id)).toEqual(['a', 'b', 'c']);
    // A step the document declares but no run reached is still a row.
    expect(steps[1].outcome).toBeNull();
  });

  it('matches a live child by name, through the real snapshot pipeline', () => {
    const wizard = wizardDouble({ result: null });
    const { result } = renderHook(() => useWizardRun(wizard));

    act(() => {
      handleActivitySnapshot(node({
        children: [node({ activity_id: 'c1', path: 'wizard-demo/a', name: 'a', current: 'cloning' })],
      }));
    });

    const { steps } = result.current.join(['a', 'b']);
    expect(steps[0].live?.current).toBe('cloning');
    expect(steps[1].live).toBeNull();
    expect(result.current.live).toBe(true);
  });

  it('reports no live rows for a run this viewer never saw', () => {
    // A trigger-fired run is instance-scoped so it reaches the footer chip;
    // the durable record is the only evidence it happened.
    const wizard = wizardDouble(ran({ a: { exit_code: OK, ran: true } }));
    const { result } = renderHook(() => useWizardRun(wizard));
    const { steps } = result.current.join(['a']);
    expect(result.current.live).toBe(false);
    expect(steps[0].live).toBeNull();
    expect(stepStatus(steps[0].outcome)).toBe('completed');
  });

  it('derives what a step answer means from exit_code and ran alone', () => {
    expect(stepStatus({ exit_code: OK, ran: false })).toBe('satisfied');
    expect(stepStatus({ exit_code: OK, ran: true })).toBe('completed');
    expect(stepStatus({ exit_code: 3 })).toBe('not_applicable');
    expect(stepStatus({ exit_code: NOT_YET })).toBe('failed');
    expect(stepStatus({ exit_code: 4 })).toBe('not_found');
    expect(stepStatus({ exit_code: 7 })).toBe('refused');
    expect(stepStatus(null)).toBe('');
  });

  it('tells apart WHY a step did not finish, from the facts on its answer', () => {
    // All NOT_YET, and all "failed" until now — a person could not tell a busy
    // step from a crashed one, or a cancelled question from a timed-out one.
    expect(stepStatus({ exit_code: NOT_YET, ran: false, busy: true })).toBe('busy');
    expect(stepStatus({ exit_code: NOT_YET, timed_out: true })).toBe('timed_out');
    expect(stepStatus({ exit_code: NOT_YET, ran: true, cancelled: true })).toBe('cancelled');
    expect(stepStatus({ exit_code: NOT_YET, ran: false })).toBe('not_started');
    expect(stepStatus({ exit_code: NOT_YET, ran: true })).toBe('failed');
  });

  it('keeps answers whose step the document no longer declares', () => {
    const wizard = wizardDouble(ran({ a: { exit_code: OK }, gone: { exit_code: NOT_YET } }));
    const { result } = renderHook(() => useWizardRun(wizard));
    const { steps, orphaned } = result.current.join(['a']);
    expect(steps).toHaveLength(1);
    // Never dropped silently — they ran, and hiding them makes an edited
    // document look like it erased its own history.
    expect(orphaned.map((o) => o.step_id)).toEqual(['gone']);
  });

  it('fetches step output on the terminal edge, and not before', async () => {
    let calls = 0;
    const wizard = {
      activity_path: 'wizard-demo',
      typeId: { toString: () => SUBJECT },
      run_state: ran({ a: { exit_code: OK, command: 'true' } }),
      runDetail: async () => {
        calls += 1;
        return ran({ a: { exit_code: OK, command: 'true', stdout: 'printed' } });
      },
    } as never;

    const { result } = renderHook(() => useWizardRun(wizard));
    expect(calls).toBe(0); // no polling, and nothing on mount

    await act(async () => {
      handleActivitySnapshot(node({ state: 'running', seq: 1 }));
    });
    expect(calls).toBe(0); // still running — the output is not written yet

    await act(async () => {
      handleActivitySnapshot(node({ state: 'completed', seq: 2 }));
    });
    expect(calls).toBe(1);
    const { steps } = result.current.join(['a']);
    expect(steps[0].outcome?.stdout).toBe('printed');
  });

  it('lets the entity win over a stale run-detail', async () => {
    // `run-detail` is fetched on a gesture, so it can be OLDER than the entity.
    // Here it is the empty record left by a reset, while the entity already
    // carries the run that followed. Letting detail win wholesale hid a
    // completed run's steps entirely.
    const wizard = {
      activity_path: 'wizard-demo',
      typeId: { toString: () => SUBJECT },
      run_state: ran({ a: { exit_code: OK, detail: 'did it' } }),
      runDetail: async () => ({ result: null }),
    } as never;

    const { result } = renderHook(() => useWizardRun(wizard));
    await act(async () => { await result.current.loadDetail(); });

    const { steps } = result.current.join(['a']);
    expect(steps[0].outcome?.detail).toBe('did it');
  });

  it('takes back every stripped field from run-detail, and keeps the entity\'s own', async () => {
    // `strip_heavy` removes a step's OUTPUT on the way to the entity — stdout,
    // stderr, the reply text and the returned value. A merge that restored only
    // some of them drew an empty box for the one fact the step exists to report.
    const wizard = {
      activity_path: 'wizard-demo',
      typeId: { toString: () => SUBJECT },
      run_state: ran({ a: { exit_code: OK, detail: 'did it', command: 'python3 --version' } }),
      runDetail: async () =>
        ran({
          a: {
            exit_code: OK, detail: 'stale', command: 'python3 --version',
            stdout: 'Python 3.11.9', stderr: 'warn', text: 'reply', value: 'Python 3.11.9',
            check: { exit_code: OK, command: 'python3 --version', returncode: 0, stdout: 'Python 3.11.9' },
          },
        }),
    } as never;

    const { result } = renderHook(() => useWizardRun(wizard));
    await act(async () => { await result.current.loadDetail(); });

    const { steps } = result.current.join(['a']);
    const outcome = steps[0].outcome!;
    // The entity's own fields survive; the output arrives alongside them.
    expect(outcome.detail).toBe('did it');
    expect(outcome.stdout).toBe('Python 3.11.9');
    expect(outcome.stderr).toBe('warn');
    expect(outcome.text).toBe('reply');
    expect(outcome.value).toBe('Python 3.11.9');
    expect(outcome.check?.returncode).toBe(0);
  });
});

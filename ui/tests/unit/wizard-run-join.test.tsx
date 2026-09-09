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
import { useWizardRun } from '@src/components/assets/editor/wizard/useWizardRun';

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
    runDetail: async () => runDetail ?? { outcomes: [] },
  } as never;
}

afterEach(() => __resetActivityStoreForTest());

describe('useWizardRun.join', () => {
  it('returns steps in DOCUMENT order, not in outcome order', () => {
    const wizard = wizardDouble({
      outcomes: [{ step_id: 'c', status: 'completed' }, { step_id: 'a', status: 'completed' }],
    });
    const { result } = renderHook(() => useWizardRun(wizard));
    const { steps } = result.current.join(['a', 'b', 'c']);
    expect(steps.map((s) => s.step_id)).toEqual(['a', 'b', 'c']);
    // A step the document declares but no run reached is still a row.
    expect(steps[1].outcome).toBeNull();
  });

  it('matches a live child by name, through the real snapshot pipeline', () => {
    const wizard = wizardDouble({ outcomes: [] });
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
    const wizard = wizardDouble({ status: 'completed', outcomes: [{ step_id: 'a', status: 'completed' }] });
    const { result } = renderHook(() => useWizardRun(wizard));
    const { steps } = result.current.join(['a']);
    expect(result.current.live).toBe(false);
    expect(steps[0].live).toBeNull();
    expect(steps[0].outcome?.status).toBe('completed');
  });

  it('keeps outcomes whose step the document no longer declares', () => {
    const wizard = wizardDouble({
      outcomes: [{ step_id: 'a', status: 'completed' }, { step_id: 'gone', status: 'failed' }],
    });
    const { result } = renderHook(() => useWizardRun(wizard));
    const { steps, orphaned } = result.current.join(['a']);
    expect(steps).toHaveLength(1);
    // Never dropped silently — they ran, and hiding them makes an edited
    // document look like it erased its own history.
    expect(orphaned.map((o) => o.step_id)).toEqual(['gone']);
  });

  it('fetches probes on the terminal edge, and not before', async () => {
    let calls = 0;
    const wizard = {
      activity_path: 'wizard-demo',
      typeId: { toString: () => SUBJECT },
      run_state: { outcomes: [{ step_id: 'a', status: 'completed' }] },
      runDetail: async () => {
        calls += 1;
        return { outcomes: [{ step_id: 'a', status: 'completed', probes: [{ phase: 'action', command: 'true' }] }] };
      },
    } as never;

    const { result } = renderHook(() => useWizardRun(wizard));
    expect(calls).toBe(0); // no polling, and nothing on mount

    await act(async () => {
      handleActivitySnapshot(node({ state: 'running', seq: 1 }));
    });
    expect(calls).toBe(0); // still running — the probes are not written yet

    await act(async () => {
      handleActivitySnapshot(node({ state: 'completed', seq: 2 }));
    });
    expect(calls).toBe(1);
    const { steps } = result.current.join(['a']);
    expect(steps[0].outcome?.probes?.[0].command).toBe('true');
  });

  it('lets the entity win over a stale run-detail, and still takes its probes', async () => {
    // `run-detail` is fetched on a gesture, so it can be OLDER than the entity.
    // Here it is the empty record left by a reset, while the entity already
    // carries the run that followed. Letting detail win wholesale hid a
    // completed run's steps entirely.
    const wizard = {
      activity_path: 'wizard-demo',
      typeId: { toString: () => SUBJECT },
      run_state: { outcomes: [{ step_id: 'a', status: 'completed', message: 'did it' }] },
      runDetail: async () => ({ outcomes: [] }),
    } as never;

    const { result } = renderHook(() => useWizardRun(wizard));
    await act(async () => { await result.current.loadDetail(); });

    const { steps } = result.current.join(['a']);
    expect(steps[0].outcome?.message).toBe('did it');
  });

  it('enriches the entity outcome with probes from run-detail', async () => {
    const wizard = {
      activity_path: 'wizard-demo',
      typeId: { toString: () => SUBJECT },
      run_state: { outcomes: [{ step_id: 'a', status: 'completed', message: 'did it' }] },
      runDetail: async () => ({
        outcomes: [{ step_id: 'a', status: 'completed', probes: [{ phase: 'action', command: 'true' }] }],
      }),
    } as never;

    const { result } = renderHook(() => useWizardRun(wizard));
    await act(async () => { await result.current.loadDetail(); });

    const { steps } = result.current.join(['a']);
    // The entity's message survives, and the probes arrive alongside it.
    expect(steps[0].outcome?.message).toBe('did it');
    expect(steps[0].outcome?.probes?.[0].command).toBe('true');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityProgressSpec } from '@sdk/activity';
import {
  RECEIPT_LINGER_MS,
  __resetActivityStoreForTest,
  getActivities,
  getActivity,
  handleActivitySnapshot,
  subscribeToActivities,
} from '@src/store/activity-store';

/**
 * The frontend mirror of the backend monitor, driven through its real ingestion point.
 *
 * Three behaviours are load-bearing and invisible when broken: ordering by `seq`, the
 * grace period that keeps a finished activity's receipt readable after the backend has
 * already evicted it, and the fact that a recycled address is a NEW activity rather than
 * a continuation of the old one.
 */

function spec(over: Partial<ActivityProgressSpec> = {}): ActivityProgressSpec {
  return {
    activity_id: 'a1',
    scope: null,
    path: 'index',
    name: 'index',
    label: null,
    icon: null,
    state: 'running',
    current: null,
    message: null,
    done: 0,
    total: null,
    skipped: 0,
    errors_count: 0,
    errors: [],
    counters: {},
    children: [],
    started_at: '2026-09-03T12:00:00Z',
    updated_at: '2026-09-03T12:00:01Z',
    finished_at: null,
    seq: 1,
    ...over,
  };
}

describe('activity store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetActivityStoreForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetActivityStoreForTest();
  });

  it('holds a snapshot and reads it back by address', () => {
    handleActivitySnapshot(spec({ done: 3, total: 10 }));

    expect(getActivity('index')?.done).toBe(3);
    expect(getActivities()).toHaveLength(1);
  });

  it('replaces state wholesale — a snapshot is complete state, never a patch', () => {
    handleActivitySnapshot(spec({ done: 3, current: 'a.md', seq: 1 }));
    handleActivitySnapshot(spec({ done: 4, current: null, seq: 2 }));

    expect(getActivity('index')?.done).toBe(4);
    expect(getActivity('index')?.current).toBeNull();
  });

  it('drops a snapshot whose seq is not greater than the one held', () => {
    handleActivitySnapshot(spec({ done: 10, seq: 5 }));

    handleActivitySnapshot(spec({ done: 2, seq: 4 }));
    handleActivitySnapshot(spec({ done: 3, seq: 5 }));

    expect(getActivity('index')?.done).toBe(10);
  });

  it('keeps scope as part of the address', () => {
    handleActivitySnapshot(spec({ done: 1 }));
    handleActivitySnapshot(spec({ activity_id: 'a2', scope: 'agentic_process-x', done: 7 }));

    expect(getActivity('index')?.done).toBe(1);
    expect(getActivity('index', 'agentic_process-x')?.done).toBe(7);
    expect(getActivities()).toHaveLength(2);
  });

  it('orders most recently updated first', () => {
    handleActivitySnapshot(spec({ path: 'old', name: 'old', updated_at: '2026-09-03T12:00:00Z' }));
    handleActivitySnapshot(
      spec({ activity_id: 'a2', path: 'new', name: 'new', updated_at: '2026-09-03T12:05:00Z' }),
    );

    expect(getActivities().map((a) => a.path)).toEqual(['new', 'old']);
  });

  it('keeps a finished activity on screen long enough to read the receipt', () => {
    handleActivitySnapshot(spec({ seq: 9, done: 10, total: 10 }));
    handleActivitySnapshot(
      spec({ seq: 10, done: 10, total: 10, state: 'completed', message: 'indexed 10', finished_at: '2026-09-03T12:01:00Z' }),
    );

    // The backend has already evicted it; the grace period is entirely ours.
    expect(getActivity('index')?.message).toBe('indexed 10');

    vi.advanceTimersByTime(RECEIPT_LINGER_MS + 1);

    expect(getActivity('index')).toBeNull();
    expect(getActivities()).toHaveLength(0);
  });

  it.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'lingers then drops a %s activity',
    (state) => {
      handleActivitySnapshot(spec({ seq: 2, state, finished_at: '2026-09-03T12:01:00Z' }));

      expect(getActivity('index')).not.toBeNull();
      vi.advanceTimersByTime(RECEIPT_LINGER_MS + 1);
      expect(getActivity('index')).toBeNull();
    },
  );

  it('a new activity at a recycled address replaces the receipt instead of being dropped', () => {
    /**
     * The backend evicts a finished root and a later `get` mints a FRESH node whose seq
     * restarts at 0. Comparing seq alone would discard every tick of the new activity
     * while the old receipt lingered — the address would look stuck on a completed run.
     */
    handleActivitySnapshot(spec({ activity_id: 'old', seq: 40, state: 'completed', finished_at: '2026-09-03T12:01:00Z' }));

    handleActivitySnapshot(spec({ activity_id: 'new', seq: 1, state: 'running', done: 1 }));

    expect(getActivity('index')?.activity_id).toBe('new');
    expect(getActivity('index')?.state).toBe('running');

    // The old receipt's eviction timer must not take the new activity with it.
    vi.advanceTimersByTime(RECEIPT_LINGER_MS + 1);
    expect(getActivity('index')?.activity_id).toBe('new');
  });

  it('carries children so a consumer can render the tree', () => {
    handleActivitySnapshot(
      spec({
        children: [spec({ activity_id: 'c1', path: 'index/pdf', name: 'pdf', done: 2, total: 5 })],
      }),
    );

    expect(getActivity('index')?.children[0].name).toBe('pdf');
  });

  it('notifies on an accepted snapshot and stays silent on a dropped one', () => {
    let notifications = 0;
    const unsubscribe = subscribeToActivities(() => {
      notifications += 1;
    });

    handleActivitySnapshot(spec({ seq: 1, done: 1 }));
    handleActivitySnapshot(spec({ seq: 2, done: 2 }));
    const afterAccepted = notifications;

    handleActivitySnapshot(spec({ seq: 2, done: 99 }));

    expect(afterAccepted).toBe(2);
    expect(notifications).toBe(2);

    unsubscribe();
    handleActivitySnapshot(spec({ seq: 3, done: 3 }));
    expect(notifications).toBe(2);
  });
});

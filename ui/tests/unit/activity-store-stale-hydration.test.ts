import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ActivityProgressSpec } from '@sdk/activity';
import { LazyAsset, lazyAssets } from '@sdk/lazy';
import {
  RECEIPT_LINGER_MS,
  __resetActivityStoreForTest,
  getActivities,
  handleActivitySnapshot,
  useActivities,
} from '@src/store/activity-store';

/**
 * A finished job must not come back to life from the hydration cache.
 *
 * Prod 2026-10-04: the renderer loaded while the boot index ran, so `GET /api/v1/activity`
 * (cached with `staleTime: Infinity`) held "index running 33/180". The index finished 17s
 * later, its terminal arrived and was evicted — and the next component to mount
 * `useActivities()` re-fed that cached row into the empty store. Nothing ever ends it, so
 * the footer read "Indexing … 22m 18s" while the backend had no index at all.
 */

function spec(over: Partial<ActivityProgressSpec>): ActivityProgressSpec {
  return {
    activity_id: 'boot-index',
    subject_entity: null,
    path: 'index',
    name: 'index',
    label: 'Indexing',
    icon: null,
    state: 'running',
    current: 'skill',
    message: null,
    done: 33,
    total: 180,
    skipped: 0,
    errors_count: 0,
    errors: [],
    counters: {},
    children: [],
    started_at: '2026-10-04T12:28:35Z',
    updated_at: '2026-10-04T12:28:39Z',
    finished_at: null,
    seq: 1314,
    ...over,
  };
}

describe('activity store — hydration cache after a job ends', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetActivityStoreForTest();
    lazyAssets.setScope(Math.random().toString());
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetActivityStoreForTest();
  });

  it('a consumer mounted after the job finished does not resurrect the mid-run snapshot', () => {
    // The GET the page made mid-run, as the lazy cache holds it.
    lazyAssets.client.setQueryData(lazyAssets.key(LazyAsset.Activities), [spec({})]);

    // The footer mounts at page load and hydrates from it.
    const footer = renderHook(() => useActivities());
    expect(getActivities().map((s) => s.state)).toEqual(['running']);

    // The run finishes over the WS and the receipt lingers out.
    act(() => {
      handleActivitySnapshot(spec({ seq: 2000, done: 180 }));
      handleActivitySnapshot(spec({ seq: 2001, done: 180, state: 'completed', finished_at: '2026-10-04T12:28:52Z' }));
    });
    act(() => {
      vi.advanceTimersByTime(RECEIPT_LINGER_MS + 1);
    });
    expect(getActivities()).toEqual([]);

    // Any later consumer (the details modal, a wizard, an ask) mounts.
    const later = renderHook(() => useActivities());

    expect(getActivities().map((s) => `${s.path}:${s.state}:${s.done}/${s.total}`)).toEqual([]);

    later.unmount();
    footer.unmount();
  });
});

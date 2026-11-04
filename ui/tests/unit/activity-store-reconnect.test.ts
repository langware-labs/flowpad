import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Replay on reconnect.
 *
 * A socket gap means missed ticks. Every snapshot is complete state, so one GET is the
 * entire reconnect story — but only if something asks for it. Without this the chip stays
 * frozen on whatever it last heard, which looks exactly like a stalled job.
 *
 * The connection manager is mocked here so the `on_open` handler can be fired directly;
 * a real reconnect is not reproducible in a unit test and would prove less.
 */

const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
vi.mock('@sdk/websocket', () => ({
  connectionManager: {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(fn);
    },
  },
}));

const listCalls: number[] = [];
vi.mock('@sdk/lazy', () => ({
  LazyAsset: { Activities: 'activities' },
  lazyAssets: { refresh: () => { listCalls.push(Date.now()); return Promise.resolve([]); } },
}));
vi.mock('@sdk/react/hooks/useLazyAsset', () => ({ useLazyAsset: () => ({ data: [] }) }));

import { __resetActivityStoreForTest, handleActivitySnapshot, replay, subscribeToActivities, useActivitySpec } from '@src/store/activity-store';
import { renderHook } from '@testing-library/react';

describe('activity store — reconnect', () => {
  beforeEach(() => {
    for (const key of Object.keys(handlers)) delete handlers[key];
    listCalls.length = 0;
    __resetActivityStoreForTest();
  });

  it('registers for the connect event, not just the first attach', () => {
    subscribeToActivities(() => {});

    expect(handlers['on_flow_data']?.length).toBe(1);
    expect(handlers['on_open']?.length).toBe(1);
  });

  it('attaches without HTTP hydration and replays on every reconnect', () => {
    subscribeToActivities(() => {});
    expect(listCalls).toHaveLength(0);

    handlers['on_open']?.forEach((fn) => fn());
    expect(listCalls).toHaveLength(1);

    handlers['on_open']?.forEach((fn) => fn());
    expect(listCalls).toHaveLength(2);
  });

  it('drops a running row the backend no longer has — its end will never arrive', async () => {
    handleActivitySnapshot({
      activity_id: 'a', subject_entity: 'wizard-x', path: 'llm-setup', name: 'llm-setup', label: 'llm-setup', state: 'running',
      message: 'checking Install Claude Code?', done: 0, skipped: 0, errors_count: 0, errors: [], counters: {}, children: [], seq: 1,
    } as never);
    const { result, rerender } = renderHook(() => useActivitySpec('llm-setup', 'wizard-x'));
    expect(result.current).not.toBeNull();

    await replay();
    rerender();

    expect(result.current).toBeNull();
  });
});

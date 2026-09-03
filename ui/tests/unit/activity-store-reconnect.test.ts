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
vi.mock('@sdk/activity', async () => {
  const actual = await vi.importActual<typeof import('@sdk/activity')>('@sdk/activity');
  return {
    ...actual,
    listActivities: () => {
      listCalls.push(Date.now());
      return Promise.resolve([]);
    },
  };
});

import { __resetActivityStoreForTest, subscribeToActivities } from '@src/store/activity-store';

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

  it('replays once on attach and again on every reconnect', () => {
    subscribeToActivities(() => {});
    expect(listCalls).toHaveLength(1);

    handlers['on_open']?.forEach((fn) => fn());
    expect(listCalls).toHaveLength(2);

    handlers['on_open']?.forEach((fn) => fn());
    expect(listCalls).toHaveLength(3);
  });
});

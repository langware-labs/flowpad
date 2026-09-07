/**
 * `useActivity` — the hook a row renders from.
 *
 * The behaviour worth a React test rather than a store test is the CLOCK. Elapsed time
 * has to advance on its own interval, not on activity snapshots, because an activity that
 * goes quiet stops producing snapshots — and that is exactly when someone is staring at
 * the row wondering whether it is slow or dead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('@sdk/websocket', () => ({ connectionManager: { on: () => {} } }));
vi.mock('@sdk/activity', async () => {
  const actual = await vi.importActual<typeof import('@sdk/activity')>('@sdk/activity');
  return { ...actual, listActivities: () => Promise.resolve([]) };
});

import type { ActivityProgressSpec } from '@sdk/activity';
import { lazyAssets } from '@sdk/lazy';
import { __resetActivityStoreForTest, handleActivitySnapshot } from '@src/store/activity-store';
import { useActivity } from '@src/hooks/useActivity';

const START = '2026-09-03T12:00:00.000Z';

function spec(over: Partial<ActivityProgressSpec> = {}): ActivityProgressSpec {
  return {
    activity_id: 'a1',
    scope: null,
    path: 'index',
    name: 'index',
    label: 'Indexing',
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
    started_at: START,
    updated_at: START,
    finished_at: null,
    seq: 1,
    ...over,
  };
}

function Probe({ path = 'index' }: { path?: string }) {
  const view = useActivity(path);
  return (
    <div>
      <span data-testid="live">{String(view.live)}</span>
      <span data-testid="elapsed">{Math.round(view.elapsedMs / 1000)}</span>
      <span data-testid="since-tick">{Math.round(view.sinceLastTickMs / 1000)}</span>
      <span data-testid="fraction">{view.fraction === null ? 'unknown' : String(view.fraction)}</span>
      <span data-testid="done">{view.spec?.done ?? -1}</span>
    </div>
  );
}

describe('useActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(START));
    __resetActivityStoreForTest();
    // `useActivitySpec` hydrates through `useLazyAsset`, so every row here also owns a
    // react-query observer. Destroying the last observer schedules a cache-eviction
    // timeout (`Query.scheduleGc`) — a timer this file's clock assertions would count as
    // the hook's own. An infinite gcTime means nothing is scheduled, so the counts below
    // measure the clock and only the clock.
    lazyAssets.client.setDefaultOptions({ queries: { gcTime: Infinity } });
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetActivityStoreForTest();
  });

  it('reports nothing for an address with no live activity', () => {
    render(<Probe path="nothing-here" />);

    expect(screen.getByTestId('live').textContent).toBe('false');
    expect(screen.getByTestId('done').textContent).toBe('-1');
    expect(screen.getByTestId('fraction').textContent).toBe('unknown');
  });

  it('re-renders when a snapshot arrives', () => {
    render(<Probe />);

    act(() => handleActivitySnapshot(spec({ done: 5, total: 10, seq: 2 })));

    expect(screen.getByTestId('done').textContent).toBe('5');
    expect(screen.getByTestId('fraction').textContent).toBe('0.5');
    expect(screen.getByTestId('live').textContent).toBe('true');
  });

  it('advances elapsed on its own clock while no snapshot arrives', () => {
    render(<Probe />);
    act(() => handleActivitySnapshot(spec({ seq: 2 })));

    expect(screen.getByTestId('elapsed').textContent).toBe('0');

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByTestId('elapsed').textContent).toBe('30');
  });

  it('grows the last-tick age so a stalled row can be told from a slow one', () => {
    render(<Probe />);
    act(() => handleActivitySnapshot(spec({ seq: 2 })));

    act(() => {
      vi.advanceTimersByTime(90_000);
    });

    expect(screen.getByTestId('since-tick').textContent).toBe('90');
  });

  it('resets the last-tick age when a snapshot does arrive', () => {
    render(<Probe />);
    act(() => handleActivitySnapshot(spec({ seq: 2 })));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    act(() =>
      handleActivitySnapshot(spec({ seq: 3, done: 1, updated_at: new Date(Date.now()).toISOString() })),
    );

    expect(screen.getByTestId('since-tick').textContent).toBe('0');
  });

  it('freezes elapsed at the end for a finished activity', () => {
    render(<Probe />);
    act(() =>
      handleActivitySnapshot(
        spec({
          seq: 2,
          state: 'completed',
          finished_at: '2026-09-03T12:00:41.000Z',
        }),
      ),
    );

    expect(screen.getByTestId('elapsed').textContent).toBe('41');
    expect(screen.getByTestId('live').textContent).toBe('false');

    // Still 41 a second later: a finished activity's elapsed is its duration, not a
    // clock that keeps running. (Only a second — past the receipt linger the store drops
    // the row entirely, which the store's own tests cover.)
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByTestId('elapsed').textContent).toBe('41');
  });

  it('reports an unknown total as unknown rather than as zero progress', () => {
    render(<Probe />);

    act(() => handleActivitySnapshot(spec({ seq: 2, done: 1204, total: null })));

    expect(screen.getByTestId('fraction').textContent).toBe('unknown');
  });

  it('rolls a parent up from children that have totals', () => {
    render(<Probe />);

    act(() =>
      handleActivitySnapshot(
        spec({
          seq: 2,
          total: null,
          children: [
            spec({ activity_id: 'c1', path: 'index/md', name: 'md', total: 100, done: 100 }),
            spec({ activity_id: 'c2', path: 'index/pdf', name: 'pdf', total: 100, done: 0 }),
          ],
        }),
      ),
    );

    expect(screen.getByTestId('fraction').textContent).toBe('0.5');
  });
  it('resyncs the shared clock when the first row wakes it', () => {
    /**
     * The clock only advances while it is running, so after an idle stretch — no rows on
     * screen — its cached value still holds whenever it last stopped. A row mounting then
     * would measure its elapsed against that stale instant and open on a wrong number.
     */
    render(<Probe />);
    act(() => handleActivitySnapshot(spec({ seq: 2 })));

    expect(screen.getByTestId('elapsed').textContent).toBe('0');
  });

  it('shares one clock across rows rather than one timer each', () => {
    /** N timers means N commits a second to move N labels, and every row re-rendering on
     *  its neighbours' schedule. */
    const before = vi.getTimerCount();
    const { unmount } = render(
      <>
        <Probe />
        <Probe />
        <Probe />
      </>,
    );
    act(() => handleActivitySnapshot(spec({ seq: 2 })));

    expect(vi.getTimerCount() - before).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(before);
  });
});

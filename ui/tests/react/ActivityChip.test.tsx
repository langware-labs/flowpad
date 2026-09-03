/**
 * The footer chip as the one "what is happening" surface.
 *
 * Drives the activity store through its real ingestion point and the pending-actions store
 * through its real WS-op callback, so the chip's own composition is what is under test:
 * one count covering agents and activities, rows that read correctly, and the three
 * display rules that were user-visible defects in the mechanism this replaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let captured: ((typeId: unknown, op: string, data: unknown) => void) | null = null;
vi.mock('@sdk/react/hooks', () => ({
  subscribeToEntityOps: (_t: string, cb: (t: unknown, op: string, d: unknown) => void) => {
    captured = cb;
    return () => {};
  },
}));
vi.mock('@sdk/websocket', () => ({ connectionManager: { on: () => {} } }));
vi.mock('@sdk/activity', async () => {
  const actual = await vi.importActual<typeof import('@sdk/activity')>('@sdk/activity');
  return { ...actual, listActivities: () => Promise.resolve([]) };
});
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => null,
  useDockNavigation: () => ({ navigation: { openShellProcess: vi.fn(), openLens: vi.fn() } }),
}));

import type { ActivityProgressSpec } from '@sdk/activity';
import { setViewMode, ViewMode } from '@src/contexts/view-mode-context';
import { __resetActivityStoreForTest, handleActivitySnapshot } from '@src/store/activity-store';
import { __resetTrackersForTest } from '@src/store/pending-actions-store';
import { PendingActionsChip } from '@src/components/footer/PendingActionsChip';

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
    started_at: '2026-09-03T12:00:00Z',
    updated_at: '2026-09-03T12:00:01Z',
    finished_at: null,
    seq: 1,
    ...over,
  };
}

async function openPopover() {
  await userEvent.click(screen.getByTestId('pending-actions-chip'));
}

describe('footer chip — activities', () => {
  beforeEach(() => {
    captured = null;
    __resetActivityStoreForTest();
    __resetTrackersForTest();
    setViewMode(ViewMode.Advanced);
  });

  afterEach(() => {
    __resetActivityStoreForTest();
    __resetTrackersForTest();
  });

  it('stays hidden when nothing is happening', () => {
    const { container } = render(<PendingActionsChip />);

    expect(container).toBeEmptyDOMElement();
  });

  it('appears and counts an activity even with no agents running', () => {
    render(<PendingActionsChip />);

    act(() => handleActivitySnapshot(spec({ seq: 2, done: 3 })));

    expect(screen.getByTestId('pending-actions-chip').textContent).toBe('1');
  });

  it('counts several activities', () => {
    render(<PendingActionsChip />);

    act(() => {
      handleActivitySnapshot(spec({ seq: 2 }));
      handleActivitySnapshot(spec({ activity_id: 'a2', path: 'qa.cycle', name: 'qa.cycle', seq: 2 }));
    });

    expect(screen.getByTestId('pending-actions-chip').textContent).toBe('2');
  });

  it('renders a bar and a percentage when the total is known', async () => {
    render(<PendingActionsChip />);
    act(() => handleActivitySnapshot(spec({ seq: 2, done: 1204, total: 5000 })));

    await openPopover();

    expect(screen.getByTestId('activity-progress').textContent).toBe('1,204/5,000 (24%)');
  });

  it('renders a bare count when the total is unknown — never a 0% bar', async () => {
    /**
     * A scan discovers as it goes. The mechanism this replaces used `total=0` to mean
     * "unknown", so a working scan showed a bar pinned at zero for its whole run.
     */
    render(<PendingActionsChip />);
    act(() => handleActivitySnapshot(spec({ seq: 2, done: 1204, total: null })));

    await openPopover();

    expect(screen.getByTestId('activity-progress').textContent).toBe('1,204');
  });

  it('shows the error count — the field that used to cross the wire and render nowhere', async () => {
    render(<PendingActionsChip />);
    act(() =>
      handleActivitySnapshot(
        spec({ seq: 2, errors_count: 300, errors: [{ message: 'encrypted', ref: 'a.pdf' }] }),
      ),
    );

    await openPopover();

    expect(screen.getByTestId('activity-errors').textContent).toContain('300');
  });

  it('hides the error badge when there are none', async () => {
    render(<PendingActionsChip />);
    act(() => handleActivitySnapshot(spec({ seq: 2 })));

    await openPopover();

    expect(screen.queryByTestId('activity-errors')).toBeNull();
  });

  it('shows what is in hand', async () => {
    render(<PendingActionsChip />);
    act(() => handleActivitySnapshot(spec({ seq: 2, current: '~/notes/q3-plan.md' })));

    await openPopover();

    expect(screen.getByTestId('activity-current').textContent).toBe('~/notes/q3-plan.md');
  });

  it('expands to children, and only on request', async () => {
    render(<PendingActionsChip />);
    act(() =>
      handleActivitySnapshot(
        spec({
          seq: 2,
          children: [spec({ activity_id: 'c1', path: 'index/pdf', name: 'pdf', label: 'pdf', total: 10, done: 2 })],
        }),
      ),
    );

    await openPopover();
    expect(screen.getAllByTestId('activity-row')).toHaveLength(1);

    await userEvent.click(screen.getByTestId('activity-expand'));

    const rows = screen.getAllByTestId('activity-row');
    expect(rows).toHaveLength(2);
    expect(rows[1].getAttribute('data-path')).toBe('index/pdf');
  });

  it('marks a blocked activity so it reads differently from a running one', async () => {
    render(<PendingActionsChip />);
    act(() => handleActivitySnapshot(spec({ seq: 2, state: 'blocked', message: 'waiting for hub login' })));

    await openPopover();

    const row = screen.getByTestId('activity-row');
    expect(row.getAttribute('data-state')).toBe('blocked');
    expect(within(row).getByTestId('activity-current').textContent).toBe('waiting for hub login');
  });

  it('leaves a process-scoped activity out of the list — its worker row already has it', async () => {
    /**
     * A process reports as an activity on the backend, which is what makes every consumer
     * see one model. In the chip the worker row is the richer representation (rename,
     * execution mode, attach/lens routing), so listing both would double-count.
     */
    render(<PendingActionsChip />);
    act(() =>
      handleActivitySnapshot(
        spec({ activity_id: 'p1', path: 'process', name: 'process', scope: 'agentic_process-abc', seq: 2 }),
      ),
    );

    expect(screen.queryByTestId('pending-actions-chip')).toBeNull();
  });
});

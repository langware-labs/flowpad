/**
 * The activity bar: a one-liner in the footer for the newest job reported to the box, its
 * receipt once it ends, and the details modal it opens. Driven through the store's real
 * ingestion point, the way WS snapshots arrive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@sdk/websocket', () => ({ connectionManager: { on: () => {} } }));
vi.mock('@sdk/activity', async () => {
  const actual = await vi.importActual<typeof import('@sdk/activity')>('@sdk/activity');
  return { ...actual, listActivities: () => Promise.resolve([]) };
});

import { __resetActivityStoreForTest, handleActivitySnapshot } from '@src/store/activity-store';
import { ActivityStatusPill } from '@src/components/footer/ActivityStatusPill';
import { ActivityDetailsModalRoot } from '@src/components/footer/ActivityDetailsModal';
import { useActivityDetailsStore } from '@src/store/use-activity-details-store';
import { activitySpec, qaTree } from '../support/activity-spec';

function renderBar() {
  return render(
    <>
      <ActivityStatusPill />
      <ActivityDetailsModalRoot />
    </>,
  );
}

describe('activity bar', () => {
  beforeEach(() => {
    __resetActivityStoreForTest();
    useActivityDetailsStore.getState().setOpen(false);
    // jsdom never runs Radix's exit animation, so a dialog left open by an earlier test
    // keeps `pointer-events: none` on the body, which a real browser clears.
    document.body.style.pointerEvents = '';
  });
  afterEach(() => __resetActivityStoreForTest());

  it('renders nothing when nothing is running', () => {
    renderBar();
    expect(screen.queryByTestId('activity-status-pill')).toBeNull();
  });

  it('shows the one-liner of a box activity', () => {
    renderBar();
    act(() => handleActivitySnapshot(qaTree()));

    expect(screen.getByTestId('activity-status-line').textContent).toBe('QA cycle · 1/2 · vitest API 2/3 (blocked) › rca · 1 failed');
  });

  it("leaves an agent's own scoped activity to its worker row", () => {
    renderBar();
    act(() => handleActivitySnapshot(activitySpec({ subject_entity: 'agentic_process-abc', label: 'mine' })));

    expect(screen.queryByTestId('activity-status-pill')).toBeNull();
  });

  it('opens the whole tree: steps by state, counters, the failure with its ref, what is in hand', async () => {
    renderBar();
    act(() => handleActivitySnapshot(qaTree()));

    await userEvent.click(screen.getByTestId('activity-status-line'));

    const modal = await screen.findByTestId('activity-details-modal');
    const rows = within(modal).getAllByTestId('activity-row');
    expect(rows.map((r) => [r.dataset.path, r.dataset.state])).toEqual([
      ['qa', 'running'],
      ['qa/p02', 'completed'],
      ['qa/p05', 'blocked'],
      ['qa/p05/fail-1', 'running'],
      ['qa/p05/fail-1/repro', 'completed'],
      ['qa/p05/fail-1/rca', 'running'],
      ['qa/p05/fail-1/fix', 'pending'],
    ]);
    expect(within(modal).getByText('runs 2')).toBeTruthy();
    expect(within(modal).getByText('api/x.test.ts › fails', { selector: 'span.font-mono' })).toBeTruthy();
    expect(within(modal).getByText('expected 1 to be 2')).toBeTruthy();
    expect(within(modal).getByText('ws_manager.py')).toBeTruthy();
    expect(within(modal).getByText('1 failing · 2 passed')).toBeTruthy();
  });

  it('keeps the receipt after the root ends, in the bar and the open modal, until dismissed', async () => {
    renderBar();
    act(() => handleActivitySnapshot(qaTree()));
    await userEvent.click(screen.getByTestId('activity-status-line'));

    act(() => handleActivitySnapshot(qaTree({ state: 'failed', message: '1 PASS · 1 RED', seq: 2 })));

    expect(screen.getByTestId('activity-status-line').textContent).toBe('QA cycle — 1 PASS · 1 RED');
    expect(screen.getByTestId('activity-status-pill').dataset.state).toBe('failed');
    expect(screen.getByTestId('activity-details-summary').textContent).toContain('QA cycle — 1 PASS · 1 RED');

    act(() => useActivityDetailsStore.getState().setOpen(false));
    // fireEvent, not userEvent: see the body pointer-events note in beforeEach.
    fireEvent.click(screen.getByTestId('activity-status-dismiss'));
    expect(screen.queryByTestId('activity-status-pill')).toBeNull();
  });

  it('prefers live work over an older receipt and counts the rest', () => {
    renderBar();
    act(() => handleActivitySnapshot(qaTree({ state: 'completed', message: 'all green' })));
    act(() => handleActivitySnapshot(activitySpec({ activity_id: 'b', path: 'index', name: 'index', label: 'Indexing', done: 3, total: 9 })));
    act(() => handleActivitySnapshot(activitySpec({ activity_id: 'c', path: 'scan', name: 'scan', label: 'Scanning', done: 1 })));

    expect(screen.getByTestId('activity-status-line').textContent).toMatch(/^(Indexing|Scanning)/);
    expect(screen.getByTestId('activity-status-more').textContent).toBe('+1');
  });
});

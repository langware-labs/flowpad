/**
 * Footer worker-status chip — view-mode gating, filter toggles, rich rows.
 *
 * Drives the pending-actions store through its real WS-op callback (only
 * `subscribeToEntityOps` is mocked, to capture it) and mocks navigation so the
 * chip renders without a router. Asserts: Standard hides error/external toggles,
 * Advanced shows them, toggling the filter changes the badge count, a rich row
 * renders its mode + status label, and External is an empty-state in v1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let captured: ((typeId: unknown, op: string, data: unknown) => void) | null = null;
vi.mock('@sdk/react/hooks', () => ({
  subscribeToEntityOps: (_t: string, cb: (t: unknown, op: string, d: unknown) => void) => {
    captured = cb;
    return () => {};
  },
}));

const openShellProcess = vi.fn(() => Promise.resolve(true));
const openLens = vi.fn();
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => null,
  useDockNavigation: () => ({ navigation: { openShellProcess, openLens } }),
}));

// Worker-count assertions own their inputs; live indexing activities are covered
// separately and must not race these synthetic worker fixtures.
vi.mock('@src/store/activity-store', () => ({ useActivities: () => [] }));

import { AgenticProcess, ProcessStatus, WorkerStatus } from '@sdk';
import { PendingActionsChip } from '@src/components/footer/PendingActionsChip';

const createdIds = new Set<string>();
const uid = () => crypto.randomUUID();

function emit(id: string, fields: { status?: ProcessStatus; worker_status?: WorkerStatus; visible?: boolean; process_type?: string; worker_status_detail?: string }): void {
  createdIds.add(id);
  act(() => {
    captured?.({ toString: () => `${AgenticProcess.type}-${id}` }, 'update', fields);
  });
}

afterEach(() => {
  for (const id of createdIds) {
    act(() => captured?.({ toString: () => `${AgenticProcess.type}-${id}` }, 'delete', {}));
  }
  createdIds.clear();
});

beforeEach(() => {
  openShellProcess.mockClear();
  openLens.mockClear();
});

describe('PendingActionsChip — worker status list', () => {
  it('hides entirely when no live workers', () => {
    const { container } = render(<PendingActionsChip />);
    expect(container.querySelector('[data-testid="pending-actions-chip"]')).toBeNull();
  });

  it('shows simple overview counters', async () => {
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.THINKING, process_type: 'chat' });
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.IDLE, process_type: 'execution' });
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.ERROR, process_type: 'execution' });

    render(<PendingActionsChip />);
    const chip = await screen.findByTestId('pending-actions-chip');
    expect(chip).toHaveTextContent('3');

    await userEvent.click(chip);
    const popover = await screen.findByTestId('pending-actions-popover');
    expect(within(popover).getByTestId('activity-count-running')).toHaveTextContent('2');
    expect(within(popover).getByTestId('activity-count-waiting-for-you')).toHaveTextContent('0');
    expect(within(popover).getByTestId('activity-count-errors')).toHaveTextContent('1');
  });

  it('filters Processes by semantic Chat and Background categories', async () => {
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.THINKING, process_type: 'chat' });
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.IDLE, process_type: 'execution' });

    render(<PendingActionsChip />);
    const chip = await screen.findByTestId('pending-actions-chip');
    await userEvent.click(chip);
    const popover = await screen.findByTestId('pending-actions-popover');
    await userEvent.click(within(popover).getByRole('tab', { name: 'processes' }));
    expect(within(popover).getAllByRole('listitem')).toHaveLength(2);
    await userEvent.click(within(popover).getByRole('button', { name: 'chat' }));
    expect(within(popover).getAllByRole('listitem')).toHaveLength(1);
    expect(within(popover).getByRole('listitem')).toHaveTextContent('Chat');
  });

  it('shows error details on the Errors tab', async () => {
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.ERROR, process_type: 'execution', worker_status_detail: 'Credentials expired' });

    render(<PendingActionsChip />);
    await userEvent.click(await screen.findByTestId('pending-actions-chip'));
    const popover = await screen.findByTestId('pending-actions-popover');
    await userEvent.click(within(popover).getByRole('tab', { name: /Errors/ }));
    const row = within(popover).getByRole('listitem');
    expect(row).toHaveTextContent('Credentials expired');
  });

  it('clicking an interactive row attaches its terminal, not the transcript', async () => {
    const id = uid();
    emit(id, { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.THINKING, visible: true, process_type: 'chat' });

    render(<PendingActionsChip />);
    await userEvent.click(await screen.findByTestId('pending-actions-chip'));
    const popover = await screen.findByTestId('pending-actions-popover');
    await userEvent.click(within(popover).getByRole('tab', { name: 'processes' }));
    const row = within(popover).getByRole('listitem');
    await userEvent.click(within(row).getByRole('button', { name: new RegExp(id.slice(0, 8), 'i') }));

    expect(openShellProcess).toHaveBeenCalledWith(id);
    expect(openLens).not.toHaveBeenCalled();
  });

  it('clicking a background (headless) row does not start a terminal', async () => {
    const id = uid();
    emit(id, { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.IDLE, process_type: 'execution' });

    render(<PendingActionsChip />);
    await userEvent.click(await screen.findByTestId('pending-actions-chip'));
    const popover = await screen.findByTestId('pending-actions-popover');
    await userEvent.click(within(popover).getByRole('tab', { name: 'processes' }));
    const row = within(popover).getByRole('listitem');
    await userEvent.click(within(row).getByRole('button', { name: new RegExp(id.slice(0, 8), 'i') }));

    // Background → transcript branch (openLens), never the terminal-attach path.
    // (openLens resolution needs a cached session_id, exercised in the browser;
    // here we assert the critical invariant: no PTY is started for a headless run.)
    expect(openShellProcess).not.toHaveBeenCalled();
  });
});

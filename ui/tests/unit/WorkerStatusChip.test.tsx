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

import { AgenticProcess, ProcessStatus, WorkerStatus } from '@sdk';
import { setViewMode, ViewMode } from '@src/contexts/view-mode-context';
import { PendingActionsChip } from '@src/components/footer/PendingActionsChip';

const createdIds = new Set<string>();
const uid = () => crypto.randomUUID();

function emit(id: string, fields: { status?: ProcessStatus; worker_status?: WorkerStatus; visible?: boolean }): void {
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
  setViewMode(ViewMode.Standard);
});

beforeEach(() => {
  setViewMode(ViewMode.Standard);
  openShellProcess.mockClear();
  openLens.mockClear();
});

describe('PendingActionsChip — worker status list', () => {
  it('hides entirely when no live workers', () => {
    const { container } = render(<PendingActionsChip />);
    expect(container.querySelector('[data-testid="pending-actions-chip"]')).toBeNull();
  });

  it('Standard view: counts interactive+background, hides error/external toggles', async () => {
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.THINKING, visible: true });
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.IDLE, visible: false });
    // An error worker exists but must be invisible to Standard.
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.ERROR, visible: false });

    render(<PendingActionsChip />);
    const chip = await screen.findByTestId('pending-actions-chip');
    // Only the 2 supported (interactive + background) — error excluded.
    expect(chip).toHaveTextContent('2');

    await userEvent.click(chip);
    const popover = await screen.findByTestId('pending-actions-popover');
    expect(within(popover).getByTestId('worker-mode-interactive')).toBeInTheDocument();
    expect(within(popover).getByTestId('worker-mode-background')).toBeInTheDocument();
    expect(within(popover).queryByTestId('worker-mode-error')).toBeNull();
    expect(within(popover).queryByTestId('worker-mode-external')).toBeNull();
  });

  it('Advanced view: surfaces error + external toggles and counts the error worker', async () => {
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.THINKING, visible: true });
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.ERROR, visible: false });
    act(() => setViewMode(ViewMode.Advanced));

    render(<PendingActionsChip />);
    const chip = await screen.findByTestId('pending-actions-chip');
    expect(chip).toHaveTextContent('2'); // interactive + error

    await userEvent.click(chip);
    const popover = await screen.findByTestId('pending-actions-popover');
    expect(within(popover).getByTestId('worker-mode-error')).toBeInTheDocument();
    expect(within(popover).getByTestId('worker-mode-external')).toBeInTheDocument();
  });

  it('toggling a mode filter changes the badge count', async () => {
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.THINKING, visible: true });
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.IDLE, visible: false });

    render(<PendingActionsChip />);
    const chip = await screen.findByTestId('pending-actions-chip');
    expect(chip).toHaveTextContent('2');

    await userEvent.click(chip);
    const popover = await screen.findByTestId('pending-actions-popover');
    // Click the Background toggle: in the "all shown" state this narrows to
    // everything-but-background → only the interactive worker remains.
    await userEvent.click(within(popover).getByTestId('worker-mode-background'));
    expect(await screen.findByTestId('pending-actions-chip')).toHaveTextContent('1');
  });

  it('renders a rich row with mode + status label', async () => {
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.THINKING, visible: true });

    render(<PendingActionsChip />);
    await userEvent.click(await screen.findByTestId('pending-actions-chip'));
    const popover = await screen.findByTestId('pending-actions-popover');
    const row = within(popover).getByRole('listitem');
    expect(row).toHaveTextContent('Interactive');
    expect(row).toHaveTextContent('Thinking');
  });

  it('External filter shows an empty state in v1', async () => {
    emit(uid(), { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.THINKING, visible: true });
    act(() => setViewMode(ViewMode.Advanced));

    render(<PendingActionsChip />);
    await userEvent.click(await screen.findByTestId('pending-actions-chip'));
    const popover = await screen.findByTestId('pending-actions-popover');
    // Isolate the External mode by toggling the other three off (EntityTypeBar's
    // first click on a lit toggle means "all-but-this").
    await userEvent.click(within(popover).getByTestId('worker-mode-interactive'));
    await userEvent.click(within(popover).getByTestId('worker-mode-background'));
    await userEvent.click(within(popover).getByTestId('worker-mode-error'));
    expect(await screen.findByTestId('worker-list-empty')).toHaveTextContent('No external workers detected');
  });

  it('clicking an interactive row attaches its terminal, not the transcript', async () => {
    const id = uid();
    emit(id, { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.THINKING, visible: true });

    render(<PendingActionsChip />);
    await userEvent.click(await screen.findByTestId('pending-actions-chip'));
    const popover = await screen.findByTestId('pending-actions-popover');
    const row = within(popover).getByRole('listitem');
    await userEvent.click(within(row).getByRole('button', { name: new RegExp(id.slice(0, 8), 'i') }));

    expect(openShellProcess).toHaveBeenCalledWith(id);
    expect(openLens).not.toHaveBeenCalled();
  });

  it('clicking a background (headless) row does not start a terminal', async () => {
    const id = uid();
    emit(id, { status: ProcessStatus.RUNNING, worker_status: WorkerStatus.IDLE, visible: false });

    render(<PendingActionsChip />);
    await userEvent.click(await screen.findByTestId('pending-actions-chip'));
    const popover = await screen.findByTestId('pending-actions-popover');
    const row = within(popover).getByRole('listitem');
    await userEvent.click(within(row).getByRole('button', { name: new RegExp(id.slice(0, 8), 'i') }));

    // Background → transcript branch (openLens), never the terminal-attach path.
    // (openLens resolution needs a cached session_id, exercised in the browser;
    // here we assert the critical invariant: no PTY is started for a headless run.)
    expect(openShellProcess).not.toHaveBeenCalled();
  });
});

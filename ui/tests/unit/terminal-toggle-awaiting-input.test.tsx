import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { isReadyForInput, ProcessStatus } from '@sdk';
import { TerminalBottomRibbon } from '@src/components/terminal/interactive-terminal/TerminalBottomRibbon';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Keep the ribbon light: stub the view-mode hook + Prompt Library so we render
// just the toggle chrome.
vi.mock('@src/components/view-mode', () => ({
  useIsAdvanced: () => false,
}));
vi.mock('@src/components/prompt-library/PromptLibraryMenu', () => ({
  PromptLibraryMenu: () => null,
}));

const baseProps = {
  fileCount: 0,
  isActive: true,
  openTabs: [],
  activeSideTab: null,
  onOpenSideTab: vi.fn(),
  process: null,
};

afterEach(() => cleanup());

// The chat⇄terminal toggle may only be used while the agent is awaiting the
// user's input — a mid-turn switchMode is 409'd by the backend. The gate is the
// single readiness predicate: the toggle is enabled ⇔ not busy AND (the process
// is RUNNING OR headless-idle — a CLI-transport session STOPPED between per-turn
// workers with a live session_id). "ready" and "busy" are disjoint by
// construction (!busy gates first), so enabling on ready can never hit the
// backend's busy 409. These tests pin the predicate and the ribbon wiring.

describe('isReadyForInput — the "your turn" toggle gate', () => {
  it('is true exactly for a RUNNING, non-busy process', () => {
    expect(isReadyForInput({ status: ProcessStatus.RUNNING, busy: false })).toBe(true);
    expect(isReadyForInput({ status: ProcessStatus.RUNNING })).toBe(true); // busy defaults falsy
  });

  it('is true for a headless-idle session (CLI transport, STOPPED, live session_id)', () => {
    // RCA #12a: switching terminal→chat kills the per-turn PTY and lands the
    // process at STOPPED with its session_id preserved. The toggle must stay
    // enabled so the user can switch back without first sending a message.
    expect(
      isReadyForInput({ status: ProcessStatus.STOPPED, busy: false, pty_mode: false, session_id: 'sess-abc' }),
    ).toBe(true);
  });

  it('is false when busy (turn in flight) and for non-live states with no live headless session', () => {
    // A RUNNING process with a turn in flight is busy, not ready.
    expect(isReadyForInput({ status: ProcessStatus.RUNNING, busy: true })).toBe(false);
    // A headless-idle session mid-turn is busy → not ready (no 409 hole).
    expect(
      isReadyForInput({ status: ProcessStatus.STOPPED, busy: true, pty_mode: false, session_id: 'sess-abc' }),
    ).toBe(false);
    // A stopped PTY (interactive transport) is not headless-idle → not ready.
    expect(
      isReadyForInput({ status: ProcessStatus.STOPPED, busy: false, pty_mode: true, session_id: 'sess-abc' }),
    ).toBe(false);
    for (const s of [
      ProcessStatus.NEW,
      ProcessStatus.STARTING,
      ProcessStatus.STOPPING,
      ProcessStatus.STOPPED, // no session_id → not headless-idle
      ProcessStatus.FAILED,
    ]) {
      expect(isReadyForInput({ status: s })).toBe(false);
    }
    expect(isReadyForInput({})).toBe(false);
  });
});

describe('TerminalBottomRibbon — chat⇄terminal toggle gating', () => {
  it('disables the toggle and explains why when the agent is not awaiting input', async () => {
    const onToggleView = vi.fn();
    render(
      <TerminalBottomRibbon
        {...baseProps}
        chatActive
        onToggleView={onToggleView}
        toggleEnabled={false}
      />,
    );

    const btn = screen.getByRole('button', {
      name: 'Available when the agent is waiting for your input',
    });
    expect((btn as HTMLButtonElement).disabled).toBe(true);

    // Clicking a disabled toggle is inert — never fires switchMode (no 409).
    await userEvent.click(btn);
    expect(onToggleView).not.toHaveBeenCalled();
  });

  it('enables the toggle and fires the switch when the agent is awaiting input', async () => {
    const onToggleView = vi.fn();
    render(
      <TerminalBottomRibbon
        {...baseProps}
        chatActive
        onToggleView={onToggleView}
        toggleEnabled
      />,
    );

    const btn = screen.getByRole('button', { name: 'Switch to terminal view' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(btn);
    expect(onToggleView).toHaveBeenCalledTimes(1);
  });

  it('stays disabled mid-switch even if the status would otherwise allow it', () => {
    render(
      <TerminalBottomRibbon
        {...baseProps}
        chatActive
        onToggleView={vi.fn()}
        toggleEnabled
        switching
      />,
    );
    // While switching the label is the in-flight one, and the button is disabled.
    const btn = screen.getByRole('button', { name: 'Switch to terminal view' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});

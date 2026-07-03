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
// single logical wire status: the toggle is enabled ⇔ the process is READY
// (¬busy). READY and BUSY are disjoint, so enabling on READY can never hit the
// backend's busy 409. These tests pin the predicate and the ribbon wiring.

describe('isReadyForInput — the "your turn" toggle gate', () => {
  it('is true exactly for the READY wire status', () => {
    expect(isReadyForInput({ status: ProcessStatus.READY })).toBe(true);
  });

  it('is false for BUSY and every non-live / terminal status (no 409 hole)', () => {
    for (const s of [
      ProcessStatus.BUSY,
      ProcessStatus.NEW,
      ProcessStatus.STARTING,
      ProcessStatus.STOPPING,
      ProcessStatus.STOPPED,
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

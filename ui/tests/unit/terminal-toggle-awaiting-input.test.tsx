import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { isReadyForInput, ProcessStatus } from '@sdk';
import { TerminalModeSwitch } from '@src/components/terminal/interactive-terminal/TerminalModeSwitch';
import type { ChatMode } from '@src/contexts/chat-ui-mode-context';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => cleanup());

// The chat⇄terminal switch may only be used while the agent is awaiting the
// user's input — a mid-turn switchMode is 409'd by the backend. The gate is the
// single readiness predicate: the transport segments are enabled ⇔ not busy AND
// (the process is RUNNING, fresh-headless, OR headless-idle — a CLI-transport
// session STOPPED between per-turn workers with a live session_id). "ready" and
// "busy" are disjoint by construction (!busy gates first), so enabling on ready
// can never hit the backend's busy 409. These tests pin the predicate and the
// header control's wiring.

describe('isReadyForInput — the "your turn" switch gate', () => {
  it('is true for a RUNNING, non-busy process', () => {
    expect(isReadyForInput({ status: ProcessStatus.RUNNING, busy: false })).toBe(true);
    expect(isReadyForInput({ status: ProcessStatus.RUNNING })).toBe(true); // busy defaults falsy
  });

  it('is true for a headless-idle session (CLI transport, STOPPED, live session_id)', () => {
    // RCA #12a: switching terminal→chat kills the per-turn PTY and lands the
    // process at STOPPED with its session_id preserved. The switch must stay
    // enabled so the user can switch back without first sending a message.
    expect(
      isReadyForInput({ status: ProcessStatus.STOPPED, busy: false, pty_mode: false, session_id: 'sess-abc' }),
    ).toBe(true);
  });

  it('is true for a fresh headless process before its first turn', async () => {
    const onSelect = vi.fn();
    const enabled = isReadyForInput({
      status: ProcessStatus.NEW,
      busy: false,
      pty_mode: false,
      session_id: null,
    });

    render(
      <TerminalModeSwitch
        current="chat"
        showVibe={false}
        modeSwitch={{ ptyMode: false, awaitingUserInput: enabled, switching: false, select: onSelect }}
      />,
    );

    const btn = screen.getByRole('radio', { name: 'Terminal' });
    expect(btn.disabled).toBe(false);
    await userEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith('terminal');
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
      ProcessStatus.STARTING,
      ProcessStatus.STOPPING,
      ProcessStatus.STOPPED, // no session_id → not headless-idle
      ProcessStatus.FAILED,
    ]) {
      expect(isReadyForInput({ status: s })).toBe(false);
    }
    expect(isReadyForInput({ status: ProcessStatus.NEW, pty_mode: true })).toBe(false);
    expect(isReadyForInput({})).toBe(false);
  });
});

describe('TerminalModeSwitch — transport segment gating', () => {
  /** `over` is flattened for brevity — the two per-mount props plus the hook
   *  fields, reassembled into the `modeSwitch` object the component takes. */
  const renderSwitch = (
    over: Partial<{
      current: ChatMode;
      showVibe: boolean;
      ptyMode: boolean;
      switching: boolean;
      enabled: boolean;
      onSelect: (m: ChatMode) => void;
    }> = {},
  ) => {
    const props = {
      current: 'chat' as ChatMode,
      showVibe: false,
      // Default: headless, so picking `terminal` is a real transport switch.
      ptyMode: false,
      switching: false,
      enabled: true,
      onSelect: vi.fn(),
      ...over,
    };
    render(
      <TerminalModeSwitch
        current={props.current}
        showVibe={props.showVibe}
        modeSwitch={{
          ptyMode: props.ptyMode,
          awaitingUserInput: props.enabled,
          switching: props.switching,
          select: props.onSelect,
        }}
      />,
    );
    return props;
  };

  it('marks the current mode as the selected segment', () => {
    renderSwitch({ current: 'chat' });
    expect(screen.getByRole('radio', { name: 'Chat' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Terminal' }).getAttribute('aria-checked')).toBe('false');
  });

  it('disables the transport segments and explains why when the agent is not awaiting input', async () => {
    const { onSelect } = renderSwitch({ enabled: false });

    const btn = screen.getByRole('radio', { name: 'Terminal' });
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('Available when the agent is waiting for your input');

    // Clicking a disabled segment is inert — never fires switchMode (no 409).
    await userEvent.click(btn);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('enables the segments and fires the switch when the agent is awaiting input', async () => {
    const { onSelect } = renderSwitch({ enabled: true });

    const btn = screen.getByRole('radio', { name: 'Terminal' });
    expect(btn.disabled).toBe(false);

    await userEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith('terminal');
  });

  it('stays disabled mid-switch even if the status would otherwise allow it', () => {
    renderSwitch({ enabled: true, switching: true });
    const btn = screen.getByRole('radio', { name: 'Terminal' });
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('Switching…');
  });

  it('never gates the vibe segment — it does no transport work', async () => {
    // Mid-turn AND mid-switch: the two states that lock both transports. Vibe is
    // pure ?viewMode navigation onto the same process dock, so it stays live.
    const { onSelect } = renderSwitch({ enabled: false, switching: true, showVibe: true });

    const btn = screen.getByRole('radio', { name: 'Vibe' });
    expect(btn.disabled).toBe(false);
    // Not selected from a terminal header — vibe replaces the page with
    // VibeWorkspace, so `current` is only ever 'vibe' at the vibe mount.
    expect(btn.getAttribute('aria-checked')).toBe('false');

    await userEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith('vibe');
  });

  it('selects vibe at the vibe mount, where the transport is still one of the two', () => {
    // The vibe display strip renders the same control with current="vibe": the
    // session is shown in vibe while its transport stays chat or terminal, so
    // both renderer segments are live exits, not no-ops.
    renderSwitch({ current: 'vibe', ptyMode: true, showVibe: true, enabled: true });
    expect(screen.getByRole('radio', { name: 'Vibe' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Chat' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('radio', { name: 'Terminal' }).disabled).toBe(false);
  });

  it('omits the vibe segment in a popped-out window', () => {
    renderSwitch({ showVibe: false });
    expect(screen.queryByRole('radio', { name: 'Vibe' })).toBeNull();
  });

  it('never gates a segment that needs no transport work', async () => {
    // Standard view over a LIVE PTY: the skin says chat, the transport is already
    // terminal. Picking `terminal` is a free skin flip, so the mid-turn gate must
    // not swallow it — watching the raw terminal while the agent works is exactly
    // when you want it. The other direction (`chat` = kill the PTY) stays gated.
    const { onSelect } = renderSwitch({ current: 'chat', ptyMode: true, enabled: false });

    const terminalBtn = screen.getByRole('radio', { name: 'Terminal' });
    expect(terminalBtn.disabled).toBe(false);
    await userEvent.click(terminalBtn);
    expect(onSelect).toHaveBeenCalledWith('terminal');

    expect(screen.getByRole('radio', { name: 'Chat' }).disabled).toBe(true);
  });
});

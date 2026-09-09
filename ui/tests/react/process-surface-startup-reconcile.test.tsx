import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ mode: 'advanced', pty: true }));
// The two turn predicates the hook reads. They are NOT complements — readiness
// also demands a live worker — and the two switch directions gate on different
// ones, so each is drivable on its own.
const ready = vi.hoisted(() => ({ value: true }));
const busy = vi.hoisted(() => ({ value: false }));
const switchMode = vi.hoisted(() =>
  vi.fn((mode: string) => {
    state.pty = mode === 'interactive';
    return Promise.resolve();
  }),
);

vi.mock('@sdk', () => ({
  isReadyForInput: () => ready.value,
  isBusy: () => busy.value,
  PrefKey: { VIEW_MODE: 'viewMode' },
  WorkerMode: { Interactive: 'interactive', CLI: 'cli' },
}));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: null }) }));
vi.mock('@src/hooks/use-preference', () => ({ usePreferenceResolved: () => true }));
vi.mock('@src/contexts/view-mode-context', () => ({
  useViewMode: () => state.mode,
  viewModePtyMode: (mode: string) => mode === 'advanced' || mode === 'dev',
  ViewMode: {
    Vibe: 'vibe',
    Standard: 'standard',
    Advanced: 'advanced',
    Dev: 'dev',
  },
}));
vi.mock('@src/notifications/notify', () => ({
  notify: { error: vi.fn() },
}));

import {
  resetSurfaceReconcileState,
  useProcessSurface,
} from '@src/components/terminal/interactive-terminal/use-process-surface';

const process = {
  id: crypto.randomUUID(),
  typeId: null,
  get isHeadless() {
    return !state.pty;
  },
  status: 'running',
  switchMode,
  loadHistory: () => Promise.resolve(),
};

function Surface({ canSwitch, marker }: { canSwitch: boolean; marker: string }) {
  useProcessSurface({ process: process as never, canSwitch });
  return <div>{marker}</div>;
}

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.surface_transcript_reconcile.rules: EDITING use-process-surface?
//       read this tag's rules first - the surface owns the transport in BOTH directions,
//       and the gate mirrors the SERVER PER ROUTE (switch-mode 409s while busy; open
//       has no guard, so neither does the client). This file stubs loadHistory and does
//       NOT cover the transcript half
// flowpad:endcapsule tag
describe('process surface reconciliation during panel startup', () => {
  beforeEach(() => {
    state.mode = 'advanced';
    state.pty = true;
    ready.value = true;
    busy.value = false;
    switchMode.mockReset();
    switchMode.mockImplementation((mode: string) => {
      state.pty = mode === 'interactive';
      return Promise.resolve();
    });
    resetSurfaceReconcileState();
  });

  afterEach(cleanup);

  it('retains a mode change made during startup and switches once ready', async () => {
    // The change that must survive startup is standard→advanced on a headless
    // worker: `canSwitch=false` is the owning panel's own `/open` being in
    // flight, and a mode chosen in that window must still be a real transition
    // when readiness lands.
    state.mode = 'standard';
    state.pty = false;
    const view = render(<Surface canSwitch={false} marker="standard-starting" />);
    await act(async () => {});

    state.mode = 'advanced';
    view.rerender(<Surface canSwitch={false} marker="advanced-starting" />);
    await act(async () => {});
    expect(switchMode).not.toHaveBeenCalled();

    view.rerender(<Surface canSwitch marker="advanced-ready" />);
    await act(async () => {});
    expect(switchMode).toHaveBeenCalledTimes(1);
    expect(switchMode).toHaveBeenCalledWith('interactive', undefined);
  });

  it('keeps first sight non-mutating when no mode transition occurred', async () => {
    state.mode = 'standard';
    render(<Surface canSwitch marker="standard-first-sight" />);
    await act(async () => {});

    expect(switchMode).not.toHaveBeenCalled();
  });

  it('gives a headless process a PTY when first seen in a terminal mode', async () => {
    // A chat-born session (pty_mode=false) opened straight from a
    // `?viewMode=advanced` URL: the footer says Terminal, but the pane renders
    // the chat overlay because `InteractiveTerminal` follows the TRANSPORT
    // (`isHeadless`), not the mode. Nothing else on the load path supplies a
    // PTY, so the first-sight record-only rule leaves the session on the
    // wrong transport until the user toggles modes by hand.
    state.mode = 'advanced';
    state.pty = false;
    render(<Surface canSwitch marker="advanced-first-sight-headless" />);
    await act(async () => {});

    expect(switchMode).toHaveBeenCalledTimes(1);
    expect(switchMode).toHaveBeenCalledWith('interactive', undefined);
  });

  it('drains the latest mode selected while a prior switch is in flight', async () => {
    // The drain is what keeps `lastReconciledMode` honest: a mode chosen while a
    // switch is in flight is skipped at the time (the re-entry guard) and must
    // be recorded when the switch completes. Observed here by the NEXT
    // transition: if the standard chosen mid-flight were lost, the entry would
    // still read 'advanced' and the final advanced would look like no change
    // at all — no second switch.
    let finishPty: (() => void) | undefined;
    switchMode
      .mockImplementationOnce((mode: string) => {
        state.pty = mode === 'interactive';
        return new Promise<void>((resolve) => {
          finishPty = resolve;
        });
      })
      .mockImplementationOnce((mode: string) => {
        state.pty = mode === 'interactive';
        return Promise.resolve();
      });

    state.mode = 'standard';
    state.pty = false;
    const view = render(<Surface canSwitch marker="standard-first" />);
    await act(async () => {});
    expect(switchMode).not.toHaveBeenCalled(); // first sight never mutates

    state.mode = 'advanced';
    view.rerender(<Surface canSwitch marker="advanced-switching" />);
    await act(async () => {});
    expect(switchMode).toHaveBeenCalledTimes(1);
    expect(switchMode).toHaveBeenCalledWith('interactive', undefined);

    // Chosen while the switch is in flight — the re-entry guard skips it now.
    state.mode = 'standard';
    view.rerender(<Surface canSwitch marker="standard-pending" />);
    await act(async () => {});
    expect(switchMode).toHaveBeenCalledTimes(1);

    // The drain re-runs the effect with the latest mode, which is now a real
    // transport transition in its own right: the surface owns the transport in
    // BOTH directions (FLOWPAD-2105), so leaving the terminal takes the worker
    // back to headless rather than stranding it on a PTY nobody is looking at.
    await act(async () => {
      finishPty?.();
      await Promise.resolve();
    });
    expect(switchMode).toHaveBeenCalledTimes(2);
    expect(switchMode).toHaveBeenLastCalledWith('cli', undefined);
    expect(state.pty).toBe(false);

    // …and the drain having recorded 'standard' is what makes the next terminal
    // mode a real transition again rather than a no-op.
    state.mode = 'advanced';
    view.rerender(<Surface canSwitch marker="advanced-again" />);
    await act(async () => {});
    expect(switchMode).toHaveBeenCalledTimes(3);
    expect(switchMode).toHaveBeenLastCalledWith('interactive', undefined);
  });

  it('takes a terminal-backed session back to headless when the user leaves it', async () => {
    // The FLOWPAD-2105 round trip. `pty_mode` is the DURABLE transport intent,
    // so leaving it true after the user walked out of the terminal made it a
    // one-way latch: nothing in `ui/src` ever wrote it back, not even a reload.
    state.mode = 'advanced';
    state.pty = true;
    const view = render(<Surface canSwitch marker="advanced-first-sight" />);
    await act(async () => {});
    expect(switchMode).not.toHaveBeenCalled(); // first sight never mutates

    state.mode = 'standard';
    view.rerender(<Surface canSwitch marker="standard" />);
    await act(async () => {});
    expect(switchMode).toHaveBeenCalledTimes(1);
    // No dims: the headless direction has no grid to size.
    expect(switchMode).toHaveBeenCalledWith('cli', undefined);
    expect(state.pty).toBe(false);

    // Vibe is the same surface obligation as chat — and, the transport already
    // matching, it must not fire a second switch.
    state.mode = 'vibe';
    view.rerender(<Surface canSwitch marker="vibe" />);
    await act(async () => {});
    expect(switchMode).toHaveBeenCalledTimes(1);
  });

  it('defers the switch to headless while a turn is in flight', async () => {
    // The backend 409s a mid-turn switch in both directions, and it keys on
    // `is_turn_busy` — so the →CLI direction waits on BUSY, not on readiness.
    // Declining must leave the mode unrecorded so the effect retries at idle;
    // recording it would strand the session on a PTY it has left.
    busy.value = true;
    state.mode = 'advanced';
    state.pty = true;
    const view = render(<Surface canSwitch marker="advanced-busy" />);
    await act(async () => {});

    state.mode = 'standard';
    view.rerender(<Surface canSwitch marker="standard-busy" />);
    await act(async () => {});
    expect(switchMode).not.toHaveBeenCalled();

    busy.value = false;
    view.rerender(<Surface canSwitch marker="standard-idle" />);
    await act(async () => {});
    expect(switchMode).toHaveBeenCalledTimes(1);
    expect(switchMode).toHaveBeenCalledWith('cli', undefined);
  });

  it('switches a session whose PTY the user ended from the xterm', async () => {
    // `/exit` leaves the worker STOPPED: neither busy nor ready. Gating the
    // →CLI direction on readiness (the guard the →PTY direction uses) would
    // keep exactly this session on `pty_mode=true` forever.
    ready.value = false;
    state.mode = 'advanced';
    state.pty = true;
    const view = render(<Surface canSwitch marker="advanced-stopped" />);
    await act(async () => {});

    state.mode = 'standard';
    view.rerender(<Surface canSwitch marker="standard-stopped" />);
    await act(async () => {});
    expect(switchMode).toHaveBeenCalledTimes(1);
    expect(switchMode).toHaveBeenCalledWith('cli', undefined);
  });
});

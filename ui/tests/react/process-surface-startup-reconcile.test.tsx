import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ mode: 'advanced', pty: true }));
const switchMode = vi.hoisted(() =>
  vi.fn((mode: string) => {
    state.pty = mode === 'interactive';
    return Promise.resolve();
  }),
);

vi.mock('@sdk', () => ({
  isReadyForInput: () => true,
  isBusy: () => false,
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
//       the non-PTY branch MUST force loadHistory - read this tag's rules first; this
//       file stubs loadHistory and does NOT cover it
// flowpad:endcapsule tag
describe('process surface reconciliation during panel startup', () => {
  beforeEach(() => {
    state.mode = 'advanced';
    state.pty = true;
    switchMode.mockReset();
    switchMode.mockImplementation((mode: string) => {
      state.pty = mode === 'interactive';
      return Promise.resolve();
    });
    resetSurfaceReconcileState();
  });

  afterEach(cleanup);

  it('retains a mode change made during startup and switches once ready', async () => {
    // Reconciliation is one-directional since bf9b51706 ("let a surface watch a
    // turn it didn't start"): only a TERMINAL mode forces a transport, because
    // chat and vibe render the same transport-independent stream. So the change
    // that must survive startup is standard→advanced on a headless worker.
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

    await act(async () => {
      finishPty?.();
      await Promise.resolve();
    });
    expect(switchMode).toHaveBeenCalledTimes(1); // standard needs no transport

    // The worker has since gone headless on its own; selecting a terminal mode
    // is a real transition again ONLY if the drain recorded 'standard'.
    state.pty = false;
    state.mode = 'advanced';
    view.rerender(<Surface canSwitch marker="advanced-again" />);
    await act(async () => {});
    expect(switchMode).toHaveBeenCalledTimes(2);
    expect(switchMode).toHaveBeenLastCalledWith('interactive', undefined);
  });
});

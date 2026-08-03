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
    const view = render(<Surface canSwitch={false} marker="advanced-starting" />);
    await act(async () => {});

    state.mode = 'standard';
    view.rerender(<Surface canSwitch={false} marker="standard-starting" />);
    await act(async () => {});
    expect(switchMode).not.toHaveBeenCalled();

    view.rerender(<Surface canSwitch marker="standard-ready" />);
    await act(async () => {});
    expect(switchMode).toHaveBeenCalledTimes(1);
    expect(switchMode).toHaveBeenCalledWith('cli', undefined);
  });

  it('keeps first sight non-mutating when no mode transition occurred', async () => {
    state.mode = 'standard';
    render(<Surface canSwitch marker="standard-first-sight" />);
    await act(async () => {});

    expect(switchMode).not.toHaveBeenCalled();
  });

  it('drains the latest mode selected while a prior switch is in flight', async () => {
    let finishCli: (() => void) | undefined;
    switchMode
      .mockImplementationOnce((mode: string) => {
        state.pty = mode === 'interactive';
        return new Promise<void>((resolve) => {
          finishCli = resolve;
        });
      })
      .mockImplementationOnce((mode: string) => {
        state.pty = mode === 'interactive';
        return Promise.resolve();
      });

    const view = render(<Surface canSwitch marker="advanced-first" />);
    await act(async () => {});

    state.mode = 'standard';
    view.rerender(<Surface canSwitch marker="standard-switching" />);
    await act(async () => {});
    expect(switchMode).toHaveBeenCalledTimes(1);

    state.mode = 'advanced';
    view.rerender(<Surface canSwitch marker="advanced-pending" />);
    await act(async () => {});
    expect(switchMode).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishCli?.();
      await Promise.resolve();
    });

    expect(switchMode).toHaveBeenCalledTimes(2);
    expect(switchMode).toHaveBeenLastCalledWith('interactive', undefined);
  });
});

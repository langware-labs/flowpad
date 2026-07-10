import { AgenticProcess } from '@sdk';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The hook resolves the live entity via useEntity(watch) — stub it with a
// controllable value so tests can drive the busy projection directly.
let liveEntity: { busy?: boolean } | null = null;
vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => ({ data: liveEntity }),
}));

import { useTurnCompletionReconcile } from '@src/components/terminal/interactive-terminal/useTurnCompletionReconcile';

const PROCESS_ID = '00000000-0000-4000-8000-0000000000d2';

// One-shot remount convergence (D01): if a turn is already in flight when the
// pane first observes the process (browser reload severed the response
// stream), force-reload history exactly once on the busy→ready edge. Gated on
// the backend `busy` projection, never raw worker_status strings. Repeated
// busy oscillations must NOT fire N force reloads — each one is an expensive
// clear() + full re-append.
describe('useTurnCompletionReconcile', () => {
  let process: AgenticProcess;
  let loadHistorySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    liveEntity = null;
    process = new AgenticProcess({ id: PROCESS_ID });
    loadHistorySpy = vi.spyOn(process, 'loadHistory').mockResolvedValue(undefined);
  });

  afterEach(() => {
    loadHistorySpy.mockRestore();
    cleanup();
  });

  function mount() {
    return renderHook(() => useTurnCompletionReconcile(process));
  }

  it('turn in flight at first observation → exactly one force reload on the busy→ready edge', () => {
    liveEntity = { busy: true };
    const { rerender } = mount();
    expect(loadHistorySpy).not.toHaveBeenCalled(); // still busy — wait for the edge

    liveEntity = { busy: false };
    rerender();
    expect(loadHistorySpy).toHaveBeenCalledTimes(1);
    expect(loadHistorySpy).toHaveBeenCalledWith({ force: true });

    // Later local turns oscillate busy — the one-shot latch must not refire.
    liveEntity = { busy: true };
    rerender();
    liveEntity = { busy: false };
    rerender();
    liveEntity = { busy: true };
    rerender();
    liveEntity = { busy: false };
    rerender();
    expect(loadHistorySpy).toHaveBeenCalledTimes(1);
  });

  it('idle at first observation → never force-reloads (mount loadHistory already converged)', () => {
    liveEntity = { busy: false };
    const { rerender } = mount();

    liveEntity = { busy: true };
    rerender();
    liveEntity = { busy: false };
    rerender();
    expect(loadHistorySpy).not.toHaveBeenCalled();
  });

  it('defers the arm/close decision until the entity is actually observed', () => {
    liveEntity = null; // useEntity still loading
    const { rerender } = mount();
    expect(loadHistorySpy).not.toHaveBeenCalled();

    liveEntity = { busy: true }; // first real observation: turn in flight
    rerender();
    expect(loadHistorySpy).not.toHaveBeenCalled();

    liveEntity = { busy: false };
    rerender();
    expect(loadHistorySpy).toHaveBeenCalledTimes(1);
    expect(loadHistorySpy).toHaveBeenCalledWith({ force: true });
  });
});

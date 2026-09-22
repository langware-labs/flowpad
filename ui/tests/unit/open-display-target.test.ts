import { describe, expect, it, vi } from 'vitest';
import { AgenticProcess } from '@sdk';
import { openDisplayTarget } from '@src/navigation/open-display-target';
import { ViewMode } from '@src/contexts/view-mode-context';

/**
 * The reception nav seam: after `install()` returns a DisplayTarget, the FE only
 * routes it — never decides what to show. A spawned setup process opens in Vibe;
 * an app target opens the app dock, addressed by what it was shown by.
 */
function mockNav() {
  return {
    openShellProcess: vi.fn(),
    openDock: vi.fn(),
  } as never;
}

describe('openDisplayTarget', () => {
  it('routes an agentic_process target to a Vibe shell', () => {
    const nav = mockNav();
    openDisplayTarget(
      { kind: 'entity', type: AgenticProcess.type, id: 'proc-1', typeid: `${AgenticProcess.type}-proc-1` },
      nav,
    );
    expect((nav as { openShellProcess: ReturnType<typeof vi.fn> }).openShellProcess).toHaveBeenCalledWith(
      'proc-1',
      { viewMode: ViewMode.Vibe },
    );
  });

  it('routes an app target to the app dock, by the endpoint it was shown by', () => {
    const nav = mockNav();
    openDisplayTarget({ kind: 'app', typeid: 'service_endpoint-e1', endpoint_id: 'e1', runtime: 'dev' }, nav);
    const dock = (nav as { openDock: ReturnType<typeof vi.fn> }).openDock.mock.calls[0][0];
    expect(dock.viewType).toBe('app');
    expect(dock.pointer).toBe('service_endpoint-e1');
  });

  it('no-ops on null / undefined', () => {
    const nav = mockNav();
    openDisplayTarget(null, nav);
    openDisplayTarget(undefined, nav);
    expect((nav as { openShellProcess: ReturnType<typeof vi.fn> }).openShellProcess).not.toHaveBeenCalled();
    expect((nav as { openDock: ReturnType<typeof vi.fn> }).openDock).not.toHaveBeenCalled();
  });
});

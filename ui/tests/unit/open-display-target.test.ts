import { describe, expect, it, vi } from 'vitest';
import { AgenticProcess } from '@sdk';
import { openDisplayTarget } from '@src/navigation/open-display-target';
import { ViewMode } from '@src/contexts/view-mode-context';

/**
 * The reception nav seam: after `install()` returns a DisplayTarget, the FE only
 * routes it — never decides what to show. A spawned setup process opens in Vibe;
 * a webapp target opens the port preview.
 */
function mockNav() {
  return {
    openShellProcess: vi.fn(),
    openWebApp: vi.fn(),
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

  it('routes a webapp target to the port preview', () => {
    const nav = mockNav();
    openDisplayTarget({ kind: 'webapp', port: 3000 }, nav);
    expect((nav as { openWebApp: ReturnType<typeof vi.fn> }).openWebApp).toHaveBeenCalledWith('3000');
  });

  it('no-ops on null / undefined', () => {
    const nav = mockNav();
    openDisplayTarget(null, nav);
    openDisplayTarget(undefined, nav);
    expect((nav as { openShellProcess: ReturnType<typeof vi.fn> }).openShellProcess).not.toHaveBeenCalled();
    expect((nav as { openWebApp: ReturnType<typeof vi.fn> }).openWebApp).not.toHaveBeenCalled();
  });
});

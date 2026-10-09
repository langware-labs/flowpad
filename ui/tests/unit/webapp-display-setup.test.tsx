/**
 * A project's web app found NOT RUNNING is set up, not repaired: the display asks for the app's node of the
 * project's setup tree to be started (`useSetupRun` … `autoStart`) and shows "Setting things up" with the
 * live tree while it starts and runs; the repair agent waits.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebappVerdict } from '@src/components/webapp-display/classify';

const mocks = vi.hoisted(() => ({
  verdict: { current: null as unknown },
  fixStart: vi.fn(),
  setupCalls: [] as unknown[][],
}));

vi.mock('@src/components/persistent-iframe', async () => {
  const { forwardRef } = await import('react');
  return { __esModule: true, default: forwardRef(() => <div data-testid="stub-iframe" />) };
});
vi.mock('@src/components/webapp-display/useWebappDiagnostics', () => ({
  useWebappDiagnostics: () => ({ ...(mocks.verdict.current as object), refresh: vi.fn() }),
}));
vi.mock('@src/components/webapp-display/useWebappFix', () => ({
  useWebappFix: () => ({ running: false, toolCount: 0, start: mocks.fixStart, autoAttempted: false }),
}));
vi.mock('@src/components/project-setup/use-setup-run', () => ({
  useSetupRun: (...args: unknown[]) => {
    mocks.setupCalls.push(args);
    const { autoStart = false } = (args[3] ?? {}) as { autoStart?: boolean };
    return {
      tree: {
        state: 'running', detail: '', total: 2, done: 1, ran: true,
        root: { id: 'micro_app-a1', label: 'site', level: 0, state: 'running', detail: '', prepare: null, run: null, children: [], shared: false },
      },
      // The real hook: starting from the moment it is asked to auto-start until the run is known to be going.
      running: false,
      starting: autoStart,
      questionId: null,
      settleQuestion: () => {},
      start: () => Promise.resolve(),
    };
  },
}));

const { WebappDisplay } = await import('@src/components/webapp-display/WebappDisplay');

const down = { severity: 'fatal', code: 'not_running', detail: [], health: 'down', probe: {}, reloadNonce: 0 } as unknown as WebappVerdict;

describe('WebappDisplay — an app that is not running yet', () => {
  beforeEach(() => {
    mocks.fixStart.mockClear();
    mocks.setupCalls.length = 0;
    mocks.verdict.current = down;
  });
  afterEach(cleanup);

  it('asks for the app’s own setup and shows the tree instead of the debug panel', () => {
    render(<WebappDisplay endpoint={{ webapp_id: 'a1', project_id: 'p1' } as never} src="http://localhost:4173/" />);

    expect(screen.getByTestId('webapp-setting-up').textContent).toContain('Setting things up');
    expect(screen.queryByTestId('setup-node-micro_app-a1')).not.toBeNull();
    const [project, root, , options] = mocks.setupCalls.at(-1) ?? [];
    expect([project, root, options]).toEqual(['p1', 'micro_app-a1', { autoStart: true }]);
    expect(mocks.fixStart).not.toHaveBeenCalled();
  });

  it('an app with no project to set it up in goes straight to repair', async () => {
    render(<WebappDisplay endpoint={null} src="http://localhost:4173/" />);
    expect(screen.queryByTestId('webapp-setting-up')).toBeNull();
    expect((mocks.setupCalls.at(-1)?.[3] as { autoStart?: boolean })?.autoStart).toBe(false);
    await waitFor(() => expect(mocks.fixStart).toHaveBeenCalled());
  });
});

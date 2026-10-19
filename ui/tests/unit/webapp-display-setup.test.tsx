/**
 * A project's web app found NOT RUNNING is set up, not repaired: the display asks for the app's node of the
 * shared provider Load lifecycle. The approval gate owns missing installation; the repair agent waits.
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
vi.mock('@src/components/project-setup/ProjectLoadGate', () => ({
  ProjectLoadGate: ({ projectId }: { projectId: string }) => {
    mocks.setupCalls.push([projectId]);
    return <div data-testid="project-load-gate">Load checks prerequisites; setup requires approval.</div>;
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

  it('uses the shared provider lifecycle gate instead of automatically starting setup', () => {
    render(<WebappDisplay endpoint={{ webapp_id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', project_id: 'p1' } as never} src="http://localhost:4173/" />);

    expect(screen.getByTestId('project-load-gate').textContent).toContain('setup requires approval');
    expect(mocks.setupCalls.at(-1)).toEqual(['p1']);
    expect(mocks.fixStart).not.toHaveBeenCalled();
  });

  it('an app with no project to set it up in goes straight to repair', async () => {
    render(<WebappDisplay endpoint={null} src="http://localhost:4173/" />);
    expect(screen.queryByTestId('project-load-gate')).toBeNull();
    expect(mocks.setupCalls).toHaveLength(0);
    await waitFor(() => expect(mocks.fixStart).toHaveBeenCalled());
  });
});

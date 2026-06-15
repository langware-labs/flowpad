/**
 * `windowMode` is derived read-only from the URL (docs/tab-management.md
 * Part 3 §7): /win/ URLs report true, dock/dev/layout-less URLs report
 * false. Nothing ever sets it — you navigate into it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

function Probe() {
  const { windowMode } = useDockNavigation();
  return <div data-testid="window-mode">{String(windowMode)}</div>;
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/win/:viewType/*', element: <Probe /> },
      { path: '/dock/:viewType/*', element: <Probe /> },
      { path: '/agent/:agentId/flow/:processId/win/:viewType/*', element: <Probe /> },
      { path: '/agent/:agentId/flow/:processId/dev/:viewType/*', element: <Probe /> },
      { path: '*', element: <Probe /> },
    ],
    { initialEntries: [path] },
  );
  return render(<RouterProvider router={router} />);
}

afterEach(cleanup);

describe('useDockNavigation().windowMode', () => {
  it('is true on a root win URL', () => {
    renderAt('/win/shell/agentic_process-1');
    expect(screen.getByTestId('window-mode').textContent).toBe('true');
  });

  it('is true on a combined-namespace win URL', () => {
    renderAt('/agent/a/flow/f/win/editor/src/app.ts');
    expect(screen.getByTestId('window-mode').textContent).toBe('true');
  });

  it('is false on dock URLs', () => {
    renderAt('/dock/shell/shell-1');
    expect(screen.getByTestId('window-mode').textContent).toBe('false');
  });

  it('is false on dev URLs', () => {
    renderAt('/agent/a/flow/f/dev/shell/shell-1');
    expect(screen.getByTestId('window-mode').textContent).toBe('false');
  });

  it('is false on layout-less URLs', () => {
    renderAt('/agent/a/flow/f');
    expect(screen.getByTestId('window-mode').textContent).toBe('false');
  });
});

/**
 * `LaunchDialog` — the SETUP stage of a launch link, on screen.
 *
 * What it must hold: the row that is running is the one shown running (with or without a
 * controller); a launch that stops marks the step it stopped at, says why, and can be run
 * again from the dialog; a controller that is not ready opens its setup wizard; and the band on
 * top names the machine this is happening on.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runs: [] as Array<{ onStep?: (s: string) => void; onNeedsSetup?: (p: unknown) => void }>,
  /** How each run ends, in order: a dock to open, or the error to reject with. */
  outcomes: [] as unknown[],
  opened: [] as unknown[],
  setups: [] as unknown[],
}));

vi.mock('@src/pages/entry/launch-runner', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runLaunch: (_plan: unknown, run: (typeof h.runs)[number]) => {
      h.runs.push(run);
      const outcome = h.outcomes.shift();
      if (outcome === undefined) return new Promise(() => {});
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
});
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ computeNode: { id: 'n1' } }),
}));
vi.mock('@src/hooks/use-workspaces', () => ({ useActiveWorkspace: () => ({ scopeId: undefined }) }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: (dock: unknown) => h.opened.push(dock) } }),
}));
vi.mock('@src/components/project-setup/project-setup-store', () => ({
  openProjectSetup: (payload: unknown) => h.setups.push(payload),
}));

const { LaunchDialog } = await import('@src/components/task-receive/LaunchDialog');
const { LaunchFailure } = await import('@src/pages/entry/launch-runner');

const status = (id: string) => screen.getByTestId(`launch-step-${id}`).getAttribute('data-status');
const WITH_CONTROLLER = { target: { projectId: 'spora' }, controllerId: 'q' };

beforeEach(() => {
  h.runs = [];
  h.outcomes = [];
  h.opened = [];
  h.setups = [];
});
afterEach(cleanup);

describe('LaunchDialog', () => {
  it('with no controller, the first row is the one running', () => {
    render(<LaunchDialog plan={{ target: { projectId: 'spora' } }} onClose={() => {}} />);

    expect(screen.queryByTestId('launch-step-controller')).toBeNull();
    expect(status('target')).toBe('loading');
    expect(status('session')).toBe('idle');
  });

  it('blames the step that stopped, says why, and runs again from the dialog', async () => {
    h.outcomes = [new LaunchFailure('target', new Error('This project is not available')), 'dock-1'];
    const onClose = vi.fn();

    render(<LaunchDialog plan={WITH_CONTROLLER} onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId('launch-error').textContent).toBe('This project is not available'));
    expect(screen.getByTestId('launch-dialog-title').textContent).toBe("Couldn't launch");
    expect(status('controller')).toBe('success');
    expect(status('target')).toBe('error');
    fireEvent.click(screen.getByTestId('launch-retry'));

    await waitFor(() => expect(h.opened).toEqual(['dock-1']));
    expect(h.runs).toHaveLength(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a machine with no model to run on is told that, not the raw error', async () => {
    h.outcomes = [new LaunchFailure('session', new Error('claude has no usable LLM source: nothing configured'))];

    render(<LaunchDialog plan={WITH_CONTROLLER} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId('launch-error').textContent).toContain('no model to run the agent on'),
    );
    expect(status('session')).toBe('error');
  });

  it('a controller that is not ready opens its own setup', async () => {
    render(<LaunchDialog plan={WITH_CONTROLLER} onClose={() => {}} />);

    await waitFor(() => expect(h.runs).toHaveLength(1));
    h.runs[0].onNeedsSetup?.({ id: 'q', name: 'q-agent-test' });

    expect(h.setups).toEqual([{ projectId: 'q', projectName: 'q-agent-test' }]);
  });

  it('wears the runtime band of this machine', () => {
    render(<LaunchDialog plan={WITH_CONTROLLER} onClose={() => {}} />);

    expect(screen.getByTestId('runtime-strip').getAttribute('data-runtime')).toBeTruthy();
  });
});

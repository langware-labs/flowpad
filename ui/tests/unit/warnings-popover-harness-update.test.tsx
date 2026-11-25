/**
 * A worker-update warning carries an Install button: one click starts a background session whose first
 * prompt is the warning itself (which worker, from and to which version, the update command). No tab
 * opens; the card stays and shows the run's status line, with the way into its terminal.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgenticProcess, ContextEntitiesEnum, dataContext } from '@sdk';
import { WarningsPopover } from '@src/components/warnings-popover/warnings-popover';

vi.mock('@sdk/react/hooks/useLazyAsset', () => {
  const status = {
    harnesses: [
      {
        kind: 'harness.codex.cli',
        worker_type: 'codex',
        label: 'Codex',
        install: 'installed',
        version: '0.154.0',
        latest_version: '0.169.0',
        update: 'available',
        update_command: 'brew upgrade codex',
      },
    ],
  };
  return { useLazyAsset: (asset: string) => ({ data: asset === 'status' ? status : null, isLoading: false }) };
});
const openDock = vi.fn();
vi.mock('@src/navigation', () => ({ useDockNavigation: () => ({ navigation: { openTab: vi.fn(), openDock } }) }));
// The card finds its run by target; the run appears once Install has created it.
const runs: { byTarget: Record<string, unknown[]> } = { byTarget: {} };
vi.mock('@src/components/entity-execution-panel/hooks/useProcessesForTarget', () => ({
  useProcessesForTarget: (target: string | null) => ({ processes: (target && runs.byTarget[target]) || [] }),
}));
vi.mock('@src/hooks/use-flow-data-trace', () => ({ useFlowDataTrace: () => ({ events: [] }) }));

beforeEach(() => {
  dataContext.bootstrapInfo = { env: { env_name: 'desktop' } };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  dataContext.bootstrapInfo = null;
  dataContext.setWarnings([]);
  runs.byTarget = {};
  openDock.mockClear();
});

it('Install starts a background session that carries the update, and the card shows its run', async () => {
  const launch = vi.spyOn(AgenticProcess, 'launch').mockResolvedValue({ id: 'run-1' } as AgenticProcess);
  // The card is drawn from the version the last check read, so the install asks for a re-check at its end.
  const refreshStatusAfter = vi.fn(() => Promise.resolve());
  const computeNode = { refreshStatusAfter } as never;
  vi.spyOn(dataContext, 'getContextEntity').mockImplementation((key) =>
    key === ContextEntitiesEnum.CurrentComputeNodeTypeId ? computeNode : null,
  );
  const user = userEvent.setup();
  const view = render(<WarningsPopover />);

  await user.click(await screen.findByTestId('warnings-popover-trigger'));
  expect(screen.queryByTestId('warnings-popover-warning-review')).toBeNull();
  await user.click(await screen.findByTestId('warnings-popover-warning-action'));

  await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
  const opts = launch.mock.calls[0][0];
  expect(opts.scratch).toBe(true);
  expect(opts.launchPrompt).toContain('Codex 0.154.0 → 0.169.0 available');
  expect(opts.launchPrompt).toContain('brew upgrade codex');
  expect(opts.background).toBe(true);
  await waitFor(() => expect(refreshStatusAfter).toHaveBeenCalledWith('run-1'));

  // The popover stays, and no run line is drawn before there is a run.
  expect(screen.getByTestId('warnings-popover-warning-action')).toBeTruthy();
  expect(screen.queryByTestId('process-status-line')).toBeNull();

  const run = Object.assign(Object.create(AgenticProcess.prototype), {
    id: 'run-1',
    name: 'Codex update',
    status: 'running',
    worker_status: 'pending_user',
    pty_mode: false,
    session_id: 's1',
  });
  runs.byTarget[opts.target as string] = [run];
  view.rerender(<WarningsPopover />);

  await screen.findByTestId('process-status-line');
  await user.click(screen.getByTestId('process-status-line-open-terminal'));
  expect(openDock).toHaveBeenCalledWith(run.terminalDockPointer);
});

it('a background launch is headless and opens no tab', async () => {
  const proc = Object.create(AgenticProcess.prototype) as AgenticProcess;
  const createProcess = vi.fn(() => Promise.resolve(proc));
  const computeNode = { createProcess } as unknown as NonNullable<
    Parameters<typeof AgenticProcess.launch>[0]['computeNode']
  >;
  const openTerminalDock = vi.spyOn(proc, 'openTerminalDock').mockImplementation(() => {});

  await AgenticProcess.launch({ computeNode, scratch: true, background: true });
  expect(createProcess.mock.calls[0][1]).toMatchObject({ visible: false, pty_mode: false });
  expect(openTerminalDock).not.toHaveBeenCalled();

  await AgenticProcess.launch({ computeNode, scratch: true });
  expect(openTerminalDock).toHaveBeenCalledTimes(1);
});

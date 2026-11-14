/**
 * A worker-update warning carries an Install button: one click starts a session whose first prompt is the
 * warning itself (which worker, from and to which version, the update command).
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgenticProcess, dataContext } from '@sdk';
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
vi.mock('@src/navigation', () => ({ useDockNavigation: () => ({ navigation: { openTab: vi.fn() } }) }));

beforeEach(() => {
  dataContext.bootstrapInfo = { env: { env_name: 'desktop' } };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  dataContext.bootstrapInfo = null;
  dataContext.setWarnings([]);
});

it('Install starts a session that carries the update', async () => {
  const launch = vi.spyOn(AgenticProcess, 'launch').mockResolvedValue({} as AgenticProcess);
  const user = userEvent.setup();
  render(<WarningsPopover />);

  await user.click(await screen.findByTestId('warnings-popover-trigger'));
  expect(screen.queryByTestId('warnings-popover-warning-review')).toBeNull();
  await user.click(await screen.findByTestId('warnings-popover-warning-action'));

  await waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
  const opts = launch.mock.calls[0][0];
  expect(opts.scratch).toBe(true);
  expect(opts.launchPrompt).toContain('Codex 0.154.0 → 0.169.0 available');
  expect(opts.launchPrompt).toContain('brew upgrade codex');
});

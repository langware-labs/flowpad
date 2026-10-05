/**
 * A footer warning that carries a button (`UserWarning.action`): the popover draws it under the
 * message, pressing it runs the action and closes the popover, and pressing it is NOT also a click
 * on the row.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataContext, ViewType, type UserWarning } from '@sdk';
import { WarningsPopover } from '@src/components/warnings-popover/warnings-popover';

const h = vi.hoisted(() => ({ warning: null as UserWarning | null }));

vi.mock('@src/components/setup-incomplete/use-setup-incomplete-warning', () => ({
  useSetupIncompleteWarning: () => h.warning,
}));
vi.mock('@sdk/react/hooks/useLazyAsset', () => ({ useLazyAsset: () => ({ data: null, isLoading: false }) }));
vi.mock('@src/navigation', () => ({ useDockNavigation: () => ({ navigation: { openTab: vi.fn() } }) }));

describe('WarningsPopover — a warning with a button', () => {
  const rerun = vi.fn();
  const rowClick = vi.fn();

  beforeEach(() => {
    dataContext.bootstrapInfo = { env: { env_name: 'desktop' } };
    rerun.mockClear();
    rowClick.mockClear();
    h.warning = {
      id: 'setup-incomplete',
      icon: 'AlertTriangle',
      color: 'yellow',
      message: 'Setup did not finish successfully',
      description: 'An install failed or was cancelled.',
      targetView: ViewType.HOME,
      onClick: rowClick,
      action: { label: 'Run setup again', onClick: rerun },
    };
  });

  afterEach(() => {
    cleanup();
    dataContext.bootstrapInfo = null;
    dataContext.setWarnings([]);
  });

  it('draws the button, runs its action once, and closes the popover', async () => {
    const user = userEvent.setup();
    render(<WarningsPopover />);

    await user.click(await screen.findByTestId('warnings-popover-trigger'));
    expect(screen.getByText('Setup did not finish successfully')).toBeTruthy();
    await user.click(await screen.findByTestId('warnings-popover-warning-action'));

    expect(rerun).toHaveBeenCalledTimes(1);
    // The button is its own target: it must not also count as a click on the row.
    expect(rowClick).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('warnings-popover-warning-action')).toBeNull());
  });

  it('counts the warning on the footer badge', async () => {
    // The desktop stub has other derived warnings of its own, so count the DIFFERENCE.
    const badge = async () => Number((await screen.findByTestId('warnings-popover-trigger')).textContent);
    const withWarning = h.warning;
    h.warning = null;
    render(<WarningsPopover />);
    const without = await badge();
    cleanup();

    h.warning = withWarning;
    render(<WarningsPopover />);

    expect(await badge()).toBe(without + 1);
  });

  it('shows no button on a warning that declares none', async () => {
    h.warning = { ...(h.warning as UserWarning), action: undefined };
    const user = userEvent.setup();
    render(<WarningsPopover />);

    await user.click(await screen.findByTestId('warnings-popover-trigger'));

    expect(screen.getByText('Setup did not finish successfully')).toBeTruthy();
    expect(screen.queryByTestId('warnings-popover-warning-action')).toBeNull();
  });
});

/**
 * "No harness found" startup warning, end to end through the real
 * `useWarnings` hook: with every harness capability checked-and-unavailable
 * the popover shows the warning, and clicking it opens the "Harness login
 * required" modal (no targetView navigation). The only stubs are the
 * capability snapshots and desktop-mode bootstrap env.
 *
 * NOTE ON THE CONTRACT: this warning used to open the "Install a harness" wiki
 * modal directly (ec5b92d3). The device-login flow (2bcc9349) deliberately
 * superseded that — both harness warnings now open the HarnessLoginModal,
 * which itself links not-installed rows to the same wiki page, so the wiki is
 * still reachable one level in. The assertions below track the CURRENT
 * contract; the wiki-modal store is still asserted, now as a negative, so a
 * regression back to the old routing is still caught.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityManager, dataContext } from '@sdk';
import { useHarnessLoginStore } from '@src/components/harness-login/harness-login-store';
import { WarningsPopover } from '@src/components/warnings-popover/warnings-popover';
import { useWikiModalStore } from '@src/components/wiki-tip/wiki-modal';

const openTab = vi.fn();
vi.mock('@src/navigation', () => ({
  useDockNavigation: () => ({ navigation: { openTab } }),
}));

describe('WarningsPopover — no harness found', () => {
  beforeEach(() => {
    dataContext.bootstrapInfo = { env: { env_name: 'desktop' } };
    vi.spyOn(capabilityManager, 'getSnapshot').mockReturnValue({
      checked: true,
      available: false,
    } as ReturnType<typeof capabilityManager.getSnapshot>);
  });

  afterEach(() => {
    // Unmount before resetting shared state: a still-mounted popover would
    // re-write its computed warnings into dataContext after setWarnings([]).
    cleanup();
    vi.restoreAllMocks();
    dataContext.bootstrapInfo = null;
    dataContext.setWarnings([]);
    useWikiModalStore.setState({ open: false, wikiword: '' });
    useHarnessLoginStore.setState({ open: false });
    openTab.mockClear();
  });

  it('shows the warning and opens the Harness login modal on click', async () => {
    const user = userEvent.setup();
    render(<WarningsPopover />);

    await user.click(await screen.findByTestId('warnings-popover-trigger'));
    await user.click(await screen.findByText('No harness found'));

    await waitFor(() => {
      expect(useHarnessLoginStore.getState().open).toBe(true);
    });
    // The click is handled by the modal, never by tab navigation or the wiki
    // modal (the pre-2bcc9349 routing).
    expect(openTab).not.toHaveBeenCalled();
    expect(useWikiModalStore.getState().open).toBe(false);
  });

  it('stays quiet when a harness is available', async () => {
    vi.spyOn(capabilityManager, 'getSnapshot').mockReturnValue({
      checked: true,
      available: true,
    } as ReturnType<typeof capabilityManager.getSnapshot>);
    render(<WarningsPopover />);

    // Let the useWarnings effect write the computed list, then assert the
    // no-harness warning is not part of it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dataContext.warnings.some((warning) => warning.id === 'no-harness')).toBe(false);
    expect(screen.queryByText('No harness found')).toBeNull();
  });
});

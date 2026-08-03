/**
 * Alert routing: `warning`/`error` notifications pop as a toast ONLY in Dev
 * mode, but are logged to the footer warnings popover in EVERY mode — where
 * they can be dismissed one at a time or all at once. Non-alert levels
 * (`success`/`info`) are untouched: they still toast for everyone and never
 * enter the warnings list.
 *
 * The sonner module is stubbed so "did it toast?" is a direct assertion rather
 * than a DOM guess; everything else (the store, the popover, `useWarnings`) is
 * the real thing.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataContext } from '@sdk';
import { ViewMode } from '@src/contexts/view-mode-context';

const toastCustom = vi.fn();
const toastDismiss = vi.fn();
vi.mock('sonner', () => ({
  toast: { custom: toastCustom, dismiss: toastDismiss },
  Toaster: () => null,
}));

vi.mock('@src/navigation', () => ({
  useDockNavigation: () => ({ navigation: { openTab: vi.fn(), openDock: vi.fn() } }),
}));

const { notify } = await import('@src/notifications/notify');
const { useAlertStore } = await import('@src/notifications/alerts-store');
const { WarningsPopover } = await import('@src/components/warnings-popover/warnings-popover');
const viewModeContext = await import('@src/contexts/view-mode-context');

function setMode(mode: ViewMode) {
  vi.spyOn(viewModeContext, 'getEffectiveViewMode').mockReturnValue(mode);
}

describe('alert toasts are dev-only, and always logged to the footer', () => {
  beforeEach(() => {
    // Desktop bootstrap keeps `useWarnings` from contributing derived warnings
    // of its own, so the counts below are purely the logged alerts.
    dataContext.bootstrapInfo = null;
    useAlertStore.setState({ alerts: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    toastCustom.mockClear();
    toastDismiss.mockClear();
    useAlertStore.setState({ alerts: [] });
    dataContext.setWarnings([]);
  });

  it('suppresses the toast outside Dev but still logs the alert', () => {
    setMode(ViewMode.Standard);

    notify.error({ title: 'Save failed', message: 'disk full' });

    expect(toastCustom).not.toHaveBeenCalled();
    expect(useAlertStore.getState().alerts).toHaveLength(1);
    expect(useAlertStore.getState().alerts[0].title).toBe('Save failed');
  });

  it('dismisses a live toast it replaces, so a sticky busy spinner cannot hang', () => {
    setMode(ViewMode.Standard);

    const id = notify.busy({ id: 'job-1', title: 'Working' });
    expect(toastCustom).toHaveBeenCalledTimes(1);

    notify.error({ id, title: 'Job failed' });

    expect(toastCustom).toHaveBeenCalledTimes(1); // the error never toasted…
    expect(toastDismiss).toHaveBeenCalledWith('job-1'); // …but it closed the spinner
  });

  it('still toasts in Dev mode, and logs it too', () => {
    setMode(ViewMode.Dev);

    notify.warning({ title: 'Slow query' });

    expect(toastCustom).toHaveBeenCalledTimes(1);
    expect(useAlertStore.getState().alerts).toHaveLength(1);
  });

  it('leaves success/info toasts alone in every mode', () => {
    setMode(ViewMode.Standard);

    notify.success({ title: 'Saved' });
    notify.info({ title: 'Heads up' });

    expect(toastCustom).toHaveBeenCalledTimes(2);
    expect(useAlertStore.getState().alerts).toHaveLength(0);
  });

  it('collapses repeats under one id instead of stacking', () => {
    setMode(ViewMode.Standard);

    notify.error({ id: 'push-failed', title: 'Push failed', message: 'attempt 1' });
    notify.error({ id: 'push-failed', title: 'Push failed', message: 'attempt 2' });

    const { alerts } = useAlertStore.getState();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toBe('attempt 2');
  });

  it('dismisses one alert and then all of them from the popover', async () => {
    setMode(ViewMode.Standard);
    const user = userEvent.setup();

    notify.error({ id: 'a', title: 'First failure' });
    notify.error({ id: 'b', title: 'Second failure' });
    notify.warning({ id: 'c', title: 'Third failure' });

    render(<WarningsPopover />);
    await user.click(await screen.findByTestId('warnings-popover-trigger'));
    expect(await screen.findAllByTestId('warnings-popover-alert')).toHaveLength(3);

    await user.click(screen.getByLabelText('Dismiss Second failure'));
    await waitFor(() => {
      expect(screen.getAllByTestId('warnings-popover-alert')).toHaveLength(2);
    });
    expect(screen.queryByText('Second failure')).toBeNull();

    await user.click(screen.getByTestId('warnings-popover-dismiss-all'));
    await waitFor(() => {
      expect(useAlertStore.getState().alerts).toHaveLength(0);
    });
  });

  it('offers no bulk dismiss when only derived warnings are showing', async () => {
    const user = userEvent.setup();
    // No alerts logged — the popover is carrying only `useWarnings`' derived
    // warnings, which describe a live condition and are deliberately NOT
    // dismissible.
    render(<WarningsPopover />);

    await user.click(await screen.findByTestId('warnings-popover-trigger'));

    expect(screen.queryAllByTestId('warnings-popover-alert')).toHaveLength(0);
    expect(screen.queryByTestId('warnings-popover-dismiss-all')).toBeNull();
    expect(screen.queryByTestId('warnings-popover-dismiss')).toBeNull();
  });
});

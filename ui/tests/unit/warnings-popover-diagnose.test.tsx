/**
 * The stethoscope in the footer warnings popover is offered for WARNINGS, not
 * only errors. Three kinds of row live in that popover and all three are
 * diagnosable: a logged `error` alert, a logged `warning` alert, and a derived
 * warning (a live condition such as "No harness found", which is not a
 * notification at all). Each assertion is scoped to its own row — every row in
 * this popover now carries the icon, so an unscoped query is ambiguous by design.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityManager, dataContext } from '@sdk';

vi.mock('sonner', () => ({
  toast: { custom: vi.fn(), dismiss: vi.fn() },
  Toaster: () => null,
}));

vi.mock('@src/navigation', () => ({
  useDockNavigation: () => ({ navigation: { openTab: vi.fn(), openDock: vi.fn() } }),
}));

const { notify } = await import('@src/notifications/notify');
const { useAlertStore } = await import('@src/notifications/alerts-store');
const { useDiagnoseErrorStore } = await import('@src/notifications/diagnose/diagnose-error-store');
const { WarningsPopover } = await import('@src/components/warnings-popover/warnings-popover');

/** The popover row (alert or derived warning) that displays `text`. */
function rowFor(text: string): HTMLElement {
  const row = screen.getByText(text).closest('[data-testid^="warnings-popover-"]');
  if (!row) throw new Error(`no popover row found for "${text}"`);
  return row as HTMLElement;
}

describe('WarningsPopover — diagnose is offered on warnings too', () => {
  beforeEach(() => {
    dataContext.bootstrapInfo = null;
    useAlertStore.setState({ alerts: [] });
    useDiagnoseErrorStore.setState({ detail: null, kind: 'error' });
  });

  afterEach(() => {
    // Unmount before clearing shared state: a mounted popover re-writes its
    // computed warnings into dataContext after setWarnings([]).
    cleanup();
    vi.restoreAllMocks();
    useAlertStore.setState({ alerts: [] });
    useDiagnoseErrorStore.setState({ detail: null, kind: 'error' });
    dataContext.bootstrapInfo = null;
    dataContext.setWarnings([]);
  });

  it('shows a diagnose button on a warning alert as well as an error alert', async () => {
    const user = userEvent.setup();

    notify.error({ id: 'e', title: 'Save failed', message: 'disk full' });
    notify.warning({ id: 'w', title: 'Slow query', message: 'took 9s' });

    render(<WarningsPopover />);
    await user.click(await screen.findByTestId('warnings-popover-trigger'));
    await screen.findAllByTestId('warnings-popover-alert');

    expect(within(rowFor('Save failed')).getByLabelText('Diagnose this error')).toBeTruthy();
    expect(within(rowFor('Slow query')).getByLabelText('Diagnose this warning')).toBeTruthy();
  });

  it('seeds the diagnosis with the warning detail and marks it as a warning', async () => {
    const user = userEvent.setup();

    notify.warning({ id: 'w', title: 'Slow query', message: 'took 9s' });

    render(<WarningsPopover />);
    await user.click(await screen.findByTestId('warnings-popover-trigger'));
    await screen.findAllByTestId('warnings-popover-alert');
    await user.click(within(rowFor('Slow query')).getByLabelText('Diagnose this warning'));

    // `kind` is what keeps the modal from calling a warning an error, and what
    // the seeded prompt (`analyze the <kind>: …`) reads.
    expect(useDiagnoseErrorStore.getState()).toMatchObject({
      detail: 'Slow query\ntook 9s',
      kind: 'warning',
    });
  });

  it('offers it on a derived warning, which carries no notification at all', async () => {
    const user = userEvent.setup();
    // Desktop bootstrap + every harness capability checked-and-unavailable is
    // the real "No harness found" derived warning, straight through useWarnings.
    dataContext.bootstrapInfo = { env: { env_name: 'desktop' } };
    vi.spyOn(capabilityManager, 'getSnapshot').mockReturnValue({
      checked: true,
      available: false,
    } as ReturnType<typeof capabilityManager.getSnapshot>);

    render(<WarningsPopover />);
    await user.click(await screen.findByTestId('warnings-popover-trigger'));
    const row = rowFor('No harness found');
    await user.click(within(row).getByLabelText('Diagnose this warning'));

    expect(useDiagnoseErrorStore.getState().kind).toBe('warning');
    expect(useDiagnoseErrorStore.getState().detail).toContain('No harness found');
  });
});

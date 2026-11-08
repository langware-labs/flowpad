/**
 * Diagnosis in the footer warnings popover is offered for WARNINGS, not
 * only errors — a "Diagnose & fix" button on a logged alert, the stethoscope on a
 * derived warning. Three kinds of row live in that popover and all three are
 * diagnosable: a logged `error` alert, a logged `warning` alert, and a derived
 * warning (a live condition such as "No harness found", which is not a
 * notification at all). Each assertion is scoped to its own row — every row in
 * this popover now carries the icon, so an unscoped query is ambiguous by design.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataContext } from '@sdk';

const h = vi.hoisted(() => ({ install: 'not_installed' }));
// The status record, as the backend serves it once the boot sweep has looked: every CLI
// `h.install`. Funding is not read here (null), so only the install warning can fire.
vi.mock('@sdk/react/hooks/useLazyAsset', () => ({
  useLazyAsset: (asset: string) => ({
    data:
      asset === 'status'
        ? {
            harnesses: ['claude', 'codex', 'copilot', 'opencode'].map((w) => ({
              kind: `harness.${w}.cli`,
              install: h.install,
            })),
          }
        : null,
    isLoading: false,
  }),
}));

vi.mock('sonner', () => ({
  toast: { custom: vi.fn(), dismiss: vi.fn() },
  Toaster: () => null,
}));

const openDock = vi.fn();
vi.mock('@src/navigation', () => ({
  useDockNavigation: () => ({ navigation: { openTab: vi.fn(), openDock } }),
}));

const diagnoseAndFix = vi.fn(async () => {});
vi.mock('@src/notifications/diagnose/diagnose-and-fix', () => ({ diagnoseAndFix }));

// The diagnosis conversation's state, as `help-request-diagnosis` answers it.
const helpRequestDiagnosis = vi.fn();
vi.mock('@sdk', async (orig) => ({ ...(await orig<object>()), helpRequestDiagnosis }));

const { notify } = await import('@src/notifications/notify');
const { useAlertStore, useDiagnosisLinks } = await import('@src/notifications/alerts-store');
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
    useDiagnosisLinks.setState({ links: {} });
    diagnoseAndFix.mockClear();
    openDock.mockClear();
  });

  afterEach(() => {
    // Unmount before clearing shared state: a mounted popover re-writes its
    // computed warnings into dataContext after setWarnings([]).
    cleanup();
    vi.restoreAllMocks();
    useAlertStore.setState({ alerts: [] });
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

    expect(within(rowFor('Save failed')).getByTestId('warnings-popover-diagnose-fix')).toBeTruthy();
    expect(within(rowFor('Slow query')).getByTestId('warnings-popover-diagnose-fix')).toBeTruthy();
  });

  it('seeds the diagnosis with the warning detail and marks it as a warning', async () => {
    const user = userEvent.setup();

    notify.warning({ id: 'w', title: 'Slow query', message: 'took 9s' });

    render(<WarningsPopover />);
    await user.click(await screen.findByTestId('warnings-popover-trigger'));
    await screen.findAllByTestId('warnings-popover-alert');
    await user.click(within(rowFor('Slow query')).getByTestId('warnings-popover-diagnose-fix'));

    // One click, no window, no navigation: the private Diagnose & fix request, seeded with the warning; the
    // entry's key links it to the conversation, whose status the entry then shows.
    expect(diagnoseAndFix).toHaveBeenCalledWith('Slow query\ntook 9s', 'warning', 'w');
  });

  it('a diagnosed entry stays: its status, Dismiss, a disabled Diagnose & fix and Open conversation', async () => {
    const user = userEvent.setup();
    helpRequestDiagnosis.mockResolvedValue({
      diagnosing: false,
      diagnosis: { status: 'needs_action', summary: 'Your hub session expired.' },
      reportable: false,
      reported: false,
      desk: '',
      pass_on: '',
    });
    notify.error({ id: 'e', title: 'Cloud Request Failed', message: '403' });
    useDiagnosisLinks.getState().link('e', 'conv-1');

    render(<WarningsPopover />);
    await user.click(await screen.findByTestId('warnings-popover-trigger'));
    const row = rowFor('Cloud Request Failed');

    const status = await within(row).findByText('Diagnosed: Your hub session expired.');
    expect(status.closest('[data-status]')?.getAttribute('data-status')).toBe('diagnosed');
    expect((within(row).getByTestId('warnings-popover-diagnose-fix') as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(row).getByTestId('warnings-popover-open-conversation'));
    expect(String(openDock.mock.calls[0][0])).toContain('conv-1');
    await user.click(within(row).getByTestId('warnings-popover-dismiss-button'));
    expect(useAlertStore.getState().alerts).toEqual([]);
  });

  it('a reported entry the help desk answered says so', async () => {
    const user = userEvent.setup();
    helpRequestDiagnosis.mockResolvedValue({
      diagnosing: false,
      diagnosis: { status: 'unrecognized', summary: 'Unclear.' },
      reportable: false,
      reported: true,
      replied: true,
      desk: '',
      pass_on: '',
    });
    notify.error({ id: 'e', title: 'Cloud Request Failed', message: '403' });
    useDiagnosisLinks.getState().link('e', 'conv-1');

    render(<WarningsPopover />);
    await user.click(await screen.findByTestId('warnings-popover-trigger'));
    const status = await within(rowFor('Cloud Request Failed')).findByText('Help desk replied');
    expect(status.closest('[data-status]')?.getAttribute('data-status')).toBe('replied');
  });

  it('offers it on a derived warning, which carries no notification at all', async () => {
    const user = userEvent.setup();
    // Desktop bootstrap + every CLI not installed on the status record is the real
    // "No harness found" derived warning, straight through useWarnings.
    dataContext.bootstrapInfo = { env: { env_name: 'desktop' } };

    render(<WarningsPopover />);
    await user.click(await screen.findByTestId('warnings-popover-trigger'));
    const row = rowFor('No harness found');
    await user.click(within(row).getByTestId('warnings-popover-warning-diagnose-fix'));

    expect(diagnoseAndFix).toHaveBeenCalledWith(expect.stringContaining('No harness found'), 'warning', expect.any(String));
  });
});

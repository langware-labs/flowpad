/**
 * Alerts (`warning` / `error`) are logged to the footer warnings popover and,
 * outside Dev mode, deliberately do NOT pop as a toast — users were drowning in
 * them. That suppression is wrong for the one class of alert that IS the only
 * feedback an action produces: the vibe home's "Project Required", which fires
 * when a prompt is submitted with no project selected. Suppressed, the prompt
 * just vanishes and the send button reads as broken (worse in RTL, where the
 * warnings popover is the last place a user looks).
 *
 * `forceToast` opts that single alert back in without touching any other alert.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sonner', () => ({
  toast: { custom: vi.fn(), dismiss: vi.fn() },
  Toaster: () => null,
}));

const { toast: sonnerToast } = await import('sonner');
const { notify } = await import('@src/notifications/notify');
const { useAlertStore } = await import('@src/notifications/alerts-store');
const { setViewMode, ViewMode } = await import('@src/contexts/view-mode-context');

describe('notify — forceToast opts a single alert back into toasting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAlertStore.setState({ alerts: [] });
    // Vibe is the mode the reported failure happened in — anything but Dev.
    setViewMode(ViewMode.Vibe);
  });

  it('suppresses an ordinary error toast outside Dev, but still logs it', () => {
    notify.error({ title: 'Something broke', message: 'details' });

    expect(sonnerToast.custom).not.toHaveBeenCalled();
    expect(useAlertStore.getState().alerts.map((a) => a.title)).toEqual(['Something broke']);
  });

  it('toasts a forceToast error outside Dev', () => {
    notify.error({ title: 'Project Required', message: 'Please select or create a project first.', forceToast: true });

    expect(sonnerToast.custom).toHaveBeenCalledTimes(1);
  });

  it('still logs a forceToast error to the warnings popover — it is additive, not a redirect', () => {
    notify.error({ title: 'Project Required', forceToast: true });

    expect(useAlertStore.getState().alerts.map((a) => a.title)).toEqual(['Project Required']);
  });

  it('leaves the neighbouring alert in the same flow suppressed', () => {
    // `Could not start` (the launch-failure sibling) was deliberately NOT opted
    // in — this pins that the flag is per-call, not a blanket change.
    notify.error({ title: 'Could not start', message: 'Failed to start the build session.' });

    expect(sonnerToast.custom).not.toHaveBeenCalled();
  });
});

/**
 * FLOWPAD-2194 — the desktop's `project/<id>/open` action hydrates a shared
 * project and then redirects the UI with one of three shapes. The setup shape
 * (`setup_git` + `project_id`) is the existing dialog; this covers the two new
 * ones `IncomingDeepLink` must read:
 *   - `project_id` alone — already installed here, so go straight in;
 *   - `project_error=unavailable|unreachable` — say which, open nothing.
 *
 * Real `IncomingDeepLink` over a real inbound URL. Stand-ins are the boundaries:
 * dock navigation and the notification sink.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openDock: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: h.openDock }, currentDock: null }),
}));

vi.mock('@src/notifications/notify', () => ({
  notify: { error: h.notifyError, warning: h.notifyWarning, info: vi.fn(), success: vi.fn() },
}));

import { IncomingDeepLink } from '@src/components/task-receive/IncomingDeepLink';

const PID = '55555555-5555-4555-8555-555555555555';

function landOn(query: string): void {
  window.history.replaceState(null, '', `/dock/home?${query}`);
  render(<IncomingDeepLink />);
}

describe('IncomingDeepLink — project/<id>/open redirects', () => {
  beforeEach(() => {
    h.openDock.mockReset();
    h.notifyError.mockReset();
    h.notifyWarning.mockReset();
  });
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('a project already installed here opens straight in, no dialog', () => {
    landOn(`action=open&project_id=${PID}`);

    expect(h.openDock).toHaveBeenCalledTimes(1);
    expect(String(h.openDock.mock.calls[0][0].toUrl())).toContain(`/project/${PID}`);
    expect(document.querySelector('[data-testid="incoming-project-dialog"]')).toBeNull();
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it('a project the hub refused says it is no longer available and opens nothing', () => {
    landOn(`action=open&project_id=${PID}&project_error=unavailable`);

    expect(h.notifyError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.notifyError.mock.calls[0][0])).toMatch(/no longer available/);
    // Shown in every view mode (alerts are Dev-only toasts by default) and open until dismissed.
    expect(h.notifyError.mock.calls[0][0]).toMatchObject({ forceToast: true });
    expect(h.notifyError.mock.calls[0][0].durationMs ?? null).toBeNull();
    expect(h.openDock).not.toHaveBeenCalled();
  });

  it('an unreachable hub says so — not "no longer available" — and opens nothing', () => {
    landOn(`action=open&project_id=${PID}&project_error=unreachable`);

    expect(h.notifyWarning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.notifyWarning.mock.calls[0][0])).toMatch(/reach FlowPad/);
    expect(h.notifyWarning.mock.calls[0][0]).toMatchObject({ forceToast: true, durationMs: null });
    expect(h.notifyError).not.toHaveBeenCalled();
    expect(h.openDock).not.toHaveBeenCalled();
  });

  it('scrubs the payload so a refresh cannot replay it', () => {
    landOn(`action=open&project_id=${PID}&project_error=unavailable`);

    expect(window.location.search).not.toMatch(/project_error|project_id|action=open/);
  });
});

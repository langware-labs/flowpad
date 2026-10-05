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
  setPendingProject: vi.fn(),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: h.openDock }, currentDock: null }),
}));

vi.mock('@src/notifications/notify', () => ({
  notify: { error: h.notifyError, warning: h.notifyWarning, info: vi.fn(), success: vi.fn() },
}));

vi.mock('@sdk/react/hooks', () => ({ useAuth: () => ({ cloudUser: null }) }));

vi.mock('@src/store/use-incoming-project-store', () => ({
  useIncomingProjectStore: () => ({ pendingProject: null, setPendingProject: h.setPendingProject }),
}));

import { Project } from '@sdk';
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

/**
 * FLOWPAD-2199 (backward compatibility; remove in FLOWPAD-2200) — the hub's
 * email link (`setup_git` + `project_id` + `git_origin`) may reach a box that
 * holds no row for that project. It hops once through the desktop's
 * `project/<id>/open`, which mirrors the row and redirects back.
 */
describe('IncomingDeepLink — the email set-up link with no local row', () => {
  const originalLocation = window.location;
  const ORIGIN = JSON.stringify({
    owner: 'acme',
    name: 'course',
    url: 'https://github.com/acme/course.git',
    branch: 'main',
    rel_path: '',
  });
  let assign: ReturnType<typeof vi.fn>;

  function landOnEmailLink(): void {
    const query = `action=open&setup_git=1&project_id=${PID}&title=Course&git_origin=${encodeURIComponent(ORIGIN)}`;
    window.history.replaceState(null, '', `/dock/home?${query}`);
    // jsdom's real `location.assign` is unimplemented — swap in a recorder.
    assign = vi.fn();
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: Partial<Location> }).location = {
      origin: originalLocation.origin,
      href: originalLocation.href,
      pathname: originalLocation.pathname,
      search: originalLocation.search,
      assign,
    };
    render(<IncomingDeepLink />);
  }

  beforeEach(() => {
    h.setPendingProject.mockReset();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    (window as unknown as { location: Location }).location = originalLocation;
    window.history.replaceState(null, '', '/');
    vi.restoreAllMocks();
  });

  it('with no local row, hops through project/<id>/open instead of opening the dialog', async () => {
    vi.spyOn(Project, 'getById').mockResolvedValue(null);

    landOnEmailLink();

    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(`/api/v1/graph/project/${PID}/open`));
    expect(h.setPendingProject).not.toHaveBeenCalled();
  });

  it('with a local row, opens the set-up dialog as before', async () => {
    vi.spyOn(Project, 'getById').mockResolvedValue({ id: PID } as never);

    landOnEmailLink();

    await vi.waitFor(() => expect(h.setPendingProject).toHaveBeenCalledTimes(1));
    expect(h.setPendingProject.mock.calls[0][0]).toMatchObject({ projectId: PID, projectName: 'Course' });
    expect(assign).not.toHaveBeenCalled();
  });

  it('back from the hop, opens the dialog even if the row is still missing — never loops', async () => {
    vi.spyOn(Project, 'getById').mockResolvedValue(null);
    landOnEmailLink();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    cleanup();
    (window as unknown as { location: Location }).location = originalLocation;

    landOnEmailLink();

    await vi.waitFor(() => expect(h.setPendingProject).toHaveBeenCalledTimes(1));
    expect(assign).not.toHaveBeenCalled();
  });
});

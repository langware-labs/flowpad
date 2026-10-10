/**
 * `?action=launch` — the SETUP stage of a launch link reaches the app through the same deep-link
 * handler as `?action=open`: the plan is read, the URL scrubbed (a refresh must not launch twice),
 * and the launch dialog runs it. A link missing its target launches nothing and says so.
 *
 * Real `IncomingDeepLink` over a real inbound URL; the dialog is stubbed to record the plan.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ plans: [] as unknown[], notifyError: vi.fn() }));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));
vi.mock('@src/notifications/notify', () => ({
  notify: { error: h.notifyError, warning: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock('@sdk/react/hooks', () => ({ useAuth: () => ({ cloudUser: null }) }));
vi.mock('@src/store/use-incoming-project-store', () => ({
  useIncomingProjectStore: () => ({ pendingProject: null, setPendingProject: vi.fn() }),
}));
vi.mock('@src/components/task-receive/LaunchDialog', () => ({
  LaunchDialog: ({ plan }: { plan: unknown }) => {
    h.plans.push(plan);
    return <div data-testid="launch-dialog" />;
  },
}));

import { IncomingDeepLink } from '@src/components/task-receive/IncomingDeepLink';

function landOn(query: string) {
  window.history.replaceState(null, '', `/dock/home?${query}`);
  return render(<IncomingDeepLink />);
}

describe('IncomingDeepLink — ?action=launch', () => {
  beforeEach(() => {
    h.plans = [];
    h.notifyError.mockReset();
  });
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('runs the plan the link carries, and scrubs it from the URL', () => {
    const view = landOn('action=launch&target=spora&controller=q&agent=a1');

    expect(view.getByTestId('launch-dialog')).toBeTruthy();
    expect(h.plans[0]).toEqual({ target: { projectId: 'spora' }, controllerId: 'q', agentId: 'a1' });
    expect(window.location.search).toBe('');
  });

  it('a launch link with no target launches nothing and says why', () => {
    const view = landOn('action=launch&controller=q');

    expect(view.queryByTestId('launch-dialog')).toBeNull();
    expect(h.notifyError).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe('');
  });
});

/**
 * `?action=launch` — the SETUP stage of a launch link reaches the app through the same deep-link
 * handler as `?action=open`: the plan is read, the URL scrubbed (a refresh must not launch twice),
 * and the launch dialog runs it. A link missing its target launches nothing and says so.
 *
 * Real `IncomingDeepLink` over a real inbound URL; the dialog is stubbed to record the plan.
 */
import { apiClient } from '@sdk';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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
import { closeLaunch } from '@src/components/task-receive/launch-store';

/** The local server: whether it asks for a key, and the keys it minted. */
function serverAsks(enforced: boolean, known: string[] = []) {
  vi.spyOn(apiClient, 'get').mockImplementation(async (_url: string, config?: { params?: { probe?: string } }) => {
    const probe = config?.params?.probe;
    return { enforced, state: null, probed: probe && known.includes(probe) ? { context: {} } : null };
  });
}

function landOn(query: string) {
  window.history.replaceState(null, '', `/dock/home?${query}`);
  return render(<IncomingDeepLink />);
}

describe('IncomingDeepLink — ?action=launch', () => {
  beforeEach(() => {
    h.plans = [];
    h.notifyError.mockReset();
    serverAsks(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    closeLaunch();
    window.history.replaceState(null, '', '/');
  });

  it('runs the plan the link carries, and scrubs it from the URL', async () => {
    const view = landOn('action=launch&target=acme&controller=q&agent=a1');

    expect(await view.findByTestId('launch-dialog')).toBeTruthy();
    expect(h.plans[0]).toEqual({ target: { projectId: 'acme' }, controllerId: 'q', agentId: 'a1' });
    expect(window.location.search).toBe('');
  });

  it('a launch link with no target launches nothing and says why', async () => {
    const view = landOn('action=launch&controller=q');

    await waitFor(() => expect(h.notifyError).toHaveBeenCalledTimes(1));
    expect(view.queryByTestId('launch-dialog')).toBeNull();
    expect(window.location.search).toBe('');
  });
});

describe('IncomingDeepLink — a link from outside Flowpad', () => {
  beforeEach(() => {
    h.plans = [];
    serverAsks(true, ['m'.repeat(32)]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    closeLaunch();
    window.history.replaceState(null, '', '/');
  });

  it('asks before it starts anything, and starts it on Allow', async () => {
    const view = landOn('action=launch&target=acme');

    fireEvent.click(await view.findByTestId('link-allow-accept'));

    expect(await view.findByTestId('launch-dialog')).toBeTruthy();
    expect(view.queryByTestId('link-allow-dialog')).toBeNull();
  });

  it('starts nothing, and forgets the link, when the user says no', async () => {
    const view = landOn('action=launch&target=acme');

    fireEvent.click(await view.findByTestId('link-allow-deny'));

    expect(view.queryByTestId('launch-dialog')).toBeNull();
    expect(h.plans).toEqual([]);
    expect(window.location.search).toBe('');
  });

  it('runs a link that carries a key Flowpad minted, without asking', async () => {
    const view = landOn(`action=launch&target=acme&stateKey=${'m'.repeat(32)}`);

    expect(await view.findByTestId('launch-dialog')).toBeTruthy();
    expect(view.queryByTestId('link-allow-dialog')).toBeNull();
  });

  it('does not ask about a link that only opens something', async () => {
    const view = landOn('action=open&conversation_id=c1');

    await waitFor(() => expect(window.location.search).toBe(''));
    expect(view.queryByTestId('link-allow-dialog')).toBeNull();
  });
});

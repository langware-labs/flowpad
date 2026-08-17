/**
 * The sandbox card on hub home: the Open affordance and the login line.
 *
 * Opening is the one thing you come to a card to do, and it used to be an
 * `ExternalLink` icon that was `opacity-0` until hover — undiscoverable, and
 * once revealed indistinguishable from the share/secrets/delete icons beside
 * it. It is now a labelled button that is always visible; the rarer, more
 * destructive actions keep the hover treatment.
 *
 * The login line answers "whose session is this box running", which previously
 * required opening the share dialog. It reads `logged_in_user`, cached hub-side
 * whenever the workspace is brought up, so rendering it wakes nothing.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openSandbox: vi.fn(),
  sandboxes: [] as Array<Record<string, unknown>>,
  sandboxesEnabled: true,
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // Only `delete` is replaced. `dataContext` is left ALONE and mutated in
  // `beforeEach` instead: spreading it into a plain object drops its prototype,
  // and HubHome's subtree calls `dataContext.on(...)`.
  return { ...actual, dataManager: { ...(actual.dataManager as object), delete: vi.fn(() => Promise.resolve()) } };
});
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openPage: vi.fn(), openDock: vi.fn() },
    currentDock: { page: 'hub' },
  }),
  useCurrentDock: () => ({ page: 'hub' }),
  useIsHomeSurface: () => true,
}));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ currentUser: { id: 'u1', name: 'Ada' } }),
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: null }) }));
vi.mock('@src/hooks/use-projects', () => ({
  useProjects: () => ({ projects: [], isLoading: false, refetch: vi.fn() }),
}));
vi.mock('@src/hooks/use-sandboxes', () => ({
  useSandboxes: () => ({
    sandboxes: h.sandboxes,
    isLoading: false,
    refetch: vi.fn(),
    createSandbox: vi.fn(),
    launchSandbox: vi.fn(),
    launchingId: null,
    launch: vi.fn(),
    creating: false,
    steps: [],
    launchUrl: null,
    openSandbox: h.openSandbox,
    renameSandbox: vi.fn(),
    deleteSandbox: vi.fn(),
    deletingId: null,
    details: {},
  }),
  // The real rule, not a stub: which button a card shows is exactly this
  // question, and a mock that always answered "launched" would let the
  // unlaunched card rot untested.
  isLaunched: (node: { node_provider_id?: string }) => !!node.node_provider_id,
  nextSandboxName: () => 'Sandbox 2',
}));
vi.mock('@src/pages/hub-home/NewSandboxDialog', () => ({ NewSandboxDialog: () => null }));
vi.mock('@src/pages/hub-home/LaunchSandboxDialog', () => ({ LaunchSandboxDialog: () => null }));
vi.mock('@src/pages/hub-home/ShareSandboxDialog', () => ({ ShareSandboxDialog: () => null }));

import { dataContext } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { HubHome } from '@src/pages/hub-home/HubHome';

function renderHome() {
  return render(
    <TooltipProvider>
      <HubHome />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sandboxesEnabled = true;
  (dataContext as unknown as { bootstrapInfo: unknown }).bootstrapInfo = { sandboxes_enabled: true };
  h.sandboxes.length = 0;
  // A LAUNCHED box: `node_provider_id` is what `ops/setup` writes, and its
  // presence is the whole difference between an Open card and a Launch one.
  h.sandboxes.push({ id: 'node-1', name: 'Sandbox One', node_provider_id: 'sbx-1' });
});
afterEach(() => cleanup());

describe('the Open button', () => {
  it('is a labelled button, not a hover-only icon', async () => {
    renderHome();

    const open = await screen.findByTestId('sandbox-open');

    expect(open.textContent).toContain('Open');
    // The regression: `opacity-0 … group-hover:opacity-100` made this invisible
    // until the pointer happened to land on the card, so it did not exist for
    // anyone who did not already know it was there.
    expect(open.className).not.toContain('opacity-0');
    expect(open.className).not.toContain('group-hover:opacity-100');
  });

  it('opens that sandbox when clicked', async () => {
    renderHome();

    await userEvent.click(await screen.findByTestId('sandbox-open'));

    expect(h.openSandbox).toHaveBeenCalledTimes(1);
    expect(h.openSandbox.mock.calls[0][0]).toMatchObject({ id: 'node-1' });
  });

  it('is disabled, and inert, on a hub that cannot provision', async () => {
    (dataContext as unknown as { bootstrapInfo: unknown }).bootstrapInfo = { sandboxes_enabled: false };
    renderHome();

    const open = await screen.findByTestId('sandbox-open');
    expect(open.hasAttribute('disabled')).toBe(true);

    await userEvent.click(open);
    expect(h.openSandbox).not.toHaveBeenCalled();
  });
});

describe('a sandbox that was never launched', () => {
  beforeEach(() => {
    // Created, never booted: this is what `createSandbox` now leaves behind.
    h.sandboxes[0] = { id: 'node-2', name: 'Sandbox Two' };
  });

  it('offers Launch instead of Open', async () => {
    renderHome();

    expect(await screen.findByTestId('sandbox-launch')).toBeTruthy();
    // Open would be a button that 409s: the hub refuses `open-service` for a
    // node with no provider id ("this machine has not been set up yet").
    expect(screen.queryByTestId('sandbox-open')).toBeNull();
  });

  it('does not open anything when Launch is clicked — it asks first', async () => {
    renderHome();

    await userEvent.click(await screen.findByTestId('sandbox-launch'));

    // Booting is what starts costing money, and auto-login can only be chosen
    // before the box signs anyone in. Both go through the launch dialog.
    expect(h.openSandbox).not.toHaveBeenCalled();
  });

  it('says it is not started rather than probing a machine that does not exist', async () => {
    renderHome();

    expect((await screen.findByTestId('sandbox-not-launched')).textContent).toMatch(/not started/i);
    // "Checking…" would be a probe that is never coming: `ops/status` has no
    // provider id to ask about.
    expect(screen.queryByText(/Checking/)).toBeNull();
  });
});

describe('the login line', () => {
  it('names the signed-in user', async () => {
    h.sandboxes[0].logged_in_user = 'ada@example.com';
    renderHome();

    expect((await screen.findByTestId('sandbox-user')).textContent).toContain('ada@example.com');
    expect(screen.queryByTestId('sandbox-user-none')).toBeNull();
  });

  it('says signed out when there is no user', async () => {
    // `null` covers both "signed out" and "the hub has never looked" — the two
    // are indistinguishable from here and the honest rendering of both is the
    // same. What must NOT happen is rendering `undefined` or an empty string.
    h.sandboxes[0].logged_in_user = null;
    renderHome();

    const none = await screen.findByTestId('sandbox-user-none');
    expect(none.textContent ?? '').toMatch(/signed out/i);
    expect(none.textContent).not.toMatch(/undefined|null/);
    expect(screen.queryByTestId('sandbox-user')).toBeNull();
  });

  it('treats an absent field the same as signed out', async () => {
    delete h.sandboxes[0].logged_in_user;
    renderHome();

    expect(await screen.findByTestId('sandbox-user-none')).toBeTruthy();
  });

  it('flags a box whose auto-login is off', async () => {
    h.sandboxes[0].auto_login = false;
    renderHome();

    expect(await screen.findByTestId('sandbox-auto-login-off')).toBeTruthy();
  });

  it('says nothing about auto-login on an ordinary box', async () => {
    // The default is on; a badge on every card would be noise.
    h.sandboxes[0].auto_login = true;
    renderHome();

    await screen.findByTestId('sandbox-open');
    expect(screen.queryByTestId('sandbox-auto-login-off')).toBeNull();
  });
});

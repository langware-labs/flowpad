/**
 * Upgrading the FlowPad app inside a sandbox, from its card on hub home.
 *
 * The point of the button is that a fleet is kept current WITHOUT anyone signing
 * in to the machines — so what these tests pin is when it is offered and what a
 * click actually does. Two rules carry the whole behaviour:
 *
 * * it is offered only for a box there is something to upgrade in (launched, and
 *   answering), matching the Open button's rule for the same reasons; and
 * * it asks first, because the upgrade STOPS the app in the box and whoever is
 *   working in it is interrupted.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  upgradeSandbox: vi.fn(),
  upgradingId: null as string | null,
  sandboxes: [] as Array<Record<string, unknown>>,
  details: {} as Record<string, { status?: string }>,
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
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
    openSandbox: vi.fn(),
    renameSandbox: vi.fn(),
    deleteSandbox: vi.fn(),
    deletingId: null,
    logoutSandbox: vi.fn(),
    loggingOutId: null,
    upgradeSandbox: h.upgradeSandbox,
    upgradingId: h.upgradingId,
    details: h.details,
  }),
  // The real rule, not a stub — same reason the Open card's test keeps it: which
  // buttons a card shows IS this question.
  isLaunched: (node: { node_provider_id?: string }) => !!node.node_provider_id,
  nextSandboxName: () => 'Sandbox 2',
}));
vi.mock('@src/pages/hub-home/NewSandboxDialog', () => ({ NewSandboxDialog: () => null }));
vi.mock('@src/pages/hub-home/LaunchSandboxDialog', () => ({ LaunchSandboxDialog: () => null }));
vi.mock('@src/pages/hub-home/ShareSandboxDialog', () => ({ ShareSandboxDialog: () => null }));

import { dataContext, ExecutionEnvironmentStatus } from '@sdk';
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
  h.upgradingId = null;
  (dataContext as unknown as { bootstrapInfo: unknown }).bootstrapInfo = { sandboxes_enabled: true };
  h.sandboxes.length = 0;
  h.sandboxes.push({ id: 'node-1', name: 'Sandbox One', node_provider_id: 'sbx-1' });
  for (const key of Object.keys(h.details)) delete h.details[key];
});
afterEach(() => cleanup());

describe('the Upgrade button', () => {
  it('is visible without hovering — an upgrade nobody can find is one nobody runs', async () => {
    renderHome();

    const upgrade = await screen.findByTestId('sandbox-upgrade');

    expect(upgrade.className).not.toContain('opacity-0');
    expect(upgrade.className).not.toContain('group-hover:opacity-100');
  });

  it('asks before it runs, and names what stops', async () => {
    renderHome();

    await userEvent.click(await screen.findByTestId('sandbox-upgrade'));

    // The confirm exists because the upgrade interrupts whoever is in the box.
    expect(await screen.findByText(/Upgrade FlowPad on this sandbox\?/i)).toBeTruthy();
    expect(h.upgradeSandbox).not.toHaveBeenCalled();
  });

  it('upgrades that sandbox once confirmed', async () => {
    renderHome();

    await userEvent.click(await screen.findByTestId('sandbox-upgrade'));
    await userEvent.click(await screen.findByRole('button', { name: 'Upgrade' }));

    expect(h.upgradeSandbox).toHaveBeenCalledTimes(1);
    expect(h.upgradeSandbox.mock.calls[0][0]).toMatchObject({ id: 'node-1' });
  });

  it('runs nothing when the confirm is cancelled', async () => {
    renderHome();

    await userEvent.click(await screen.findByTestId('sandbox-upgrade'));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(h.upgradeSandbox).not.toHaveBeenCalled();
  });

  it('is not offered on a box that was never launched', async () => {
    // No VM, so there is no app in there to upgrade — the hub answers "this
    // machine has not been set up yet" for exactly this node.
    h.sandboxes[0] = { id: 'node-2', name: 'Sandbox Two' };
    renderHome();

    await screen.findByTestId('sandbox-launch');
    expect(screen.queryByTestId('sandbox-upgrade')).toBeNull();
  });

  it('is not offered while the box is unreachable', async () => {
    // There is a VM and it is not answering, so the upgrade could only fail.
    // The status line already says "Unreachable"; a button that reliably errors
    // would just be a second way to learn that.
    h.details['node-1'] = { status: ExecutionEnvironmentStatus.ERROR };
    renderHome();

    await screen.findByTestId('sandbox-name');
    expect(screen.queryByTestId('sandbox-upgrade')).toBeNull();
  });

  it('is inert on a hub that cannot provision', async () => {
    (dataContext as unknown as { bootstrapInfo: unknown }).bootstrapInfo = { sandboxes_enabled: false };
    renderHome();

    const upgrade = await screen.findByTestId('sandbox-upgrade');
    expect(upgrade.hasAttribute('disabled')).toBe(true);

    await userEvent.click(upgrade);
    expect(h.upgradeSandbox).not.toHaveBeenCalled();
  });

  it('spins on the box being upgraded and refuses a second click', async () => {
    h.upgradingId = 'node-1';
    renderHome();

    const upgrade = await screen.findByTestId('sandbox-upgrade');
    expect(upgrade.hasAttribute('disabled')).toBe(true);
    expect(upgrade.querySelector('.animate-spin')).toBeTruthy();
  });
});

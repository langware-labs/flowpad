/**
 * Multi-select and bulk actions on the Machines page: pick cards, see how many
 * each action applies to, confirm, and the whole eligible set goes to the hook.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  openSandbox: vi.fn(),
  openNewShell: vi.fn(() => Promise.resolve(null)),
  sandboxes: [] as Array<Record<string, unknown>>,
  details: {} as Record<string, Record<string, unknown>>,
  sandboxesEnabled: true,
  runBulkAction: vi.fn(() => Promise.resolve()),
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
    navigation: { openPage: vi.fn(), openDock: vi.fn(), openNewShell: h.openNewShell },
    currentDock: { page: 'hub' },
  }),
  useCurrentDock: () => ({ page: 'hub' }),
  useIsHomeSurface: () => true,
}));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ currentUser: { id: 'u1', name: 'Ada', email: 'ada@x.io' } }),
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: null }) }));
vi.mock('@src/hooks/use-projects', () => ({
  useProjects: () => ({ projects: [], isLoading: false, refetch: vi.fn() }),
}));
vi.mock('@src/hooks/use-sandboxes', async (importOriginal) => ({
  useSandboxes: () => ({
    sandboxes: h.sandboxes.map((s) => ({ agents: () => Promise.resolve([]), ...s })),
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
    deletingIds: new Set<string>(),
    upgradeSandbox: vi.fn(),
    upgradingIds: new Set<string>(),
    loggingOutIds: new Set<string>(),
    logoutSandbox: vi.fn(),
    runBulkAction: h.runBulkAction,
    details: h.details,
  }),
  // The real rule, not a stub: which button a card shows is exactly this
  // question, and a mock that always answered "launched" would let the
  // unlaunched card rot untested.
  isLaunched: (node: { node_provider_id?: string }) => !!node.node_provider_id,
  // Real too: the hub sends `node_provider`, the TS type says `node_provider_type`,
  // and only the real reader bridges the two.
  isUserMachine: (await importOriginal<typeof import('@src/hooks/use-sandboxes')>()).isUserMachine,
  nextSandboxName: () => 'Sandbox 2',
}));
vi.mock('@src/pages/hub-home/NewSandboxDialog', () => ({ NewSandboxDialog: () => null }));
vi.mock('@src/pages/hub-home/LaunchSandboxDialog', () => ({ LaunchSandboxDialog: () => null }));
vi.mock('@src/pages/hub-home/ShareSandboxDialog', () => ({ ShareSandboxDialog: () => null }));
// The token plan card runs a react-query hook; out of scope here.
vi.mock('@src/components/token-plan/TokenPlanCard', () => ({ TokenPlanCard: () => null }));

import { dataContext } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { HubHome } from '@src/pages/hub-home/HubHome';

function renderHome() {
  return render(
    <TooltipProvider>
      {/* The cards live on the Machines page since 093f0762d, not on Home. */}
      <HubHome view="machines" />
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.sandboxesEnabled = true;
  (dataContext as unknown as { bootstrapInfo: unknown }).bootstrapInfo = { sandboxes_enabled: true };
  h.sandboxes.length = 0;
  for (const k of Object.keys(h.details)) delete h.details[k];
  // A LAUNCHED box: `node_provider_id` is what `ops/setup` writes, and its
  // presence is the whole difference between an Open card and a Launch one.
  h.sandboxes.push(
    { id: 'node-1', name: 'One', node_provider_id: 'sbx-1', logged_in_user: 'ada@x.io' },
    { id: 'node-2', name: 'Two', node_provider_id: 'sbx-2' },
    { id: 'node-3', name: 'Three' },
  );
  h.details['node-1'] = { status: 'READY' };
  h.details['node-2'] = { status: 'ERROR' };
});
afterEach(() => cleanup());

function cards() {
  return screen.getAllByTestId('sandbox-card');
}

function select(i: number) {
  return userEvent.click(within(cards()[i]).getByTestId('sandbox-card-select'));
}

describe('selecting machines', () => {
  it('shows the selection bar with per-action counts', async () => {
    renderHome();
    expect(screen.queryByTestId('machines-selection-bar')).toBeNull();
    await select(0);
    await select(1);
    await select(2);
    expect(screen.getByTestId('machines-selection-count').textContent).toBe('3 selected');
    // Only node-1 is launched and reachable, and only node-1 is signed in as me.
    expect(screen.getByTestId('machines-bulk-upgrade').textContent).toContain('Upgrade (1)');
    expect(screen.getByTestId('machines-bulk-signout').textContent).toContain('Sign out (1)');
    expect(screen.getByTestId('machines-bulk-delete').textContent).toContain('Delete (3)');
  });

  it('disables an action no selected card can take', async () => {
    renderHome();
    await select(2);
    expect(screen.getByTestId('machines-bulk-upgrade')).toHaveProperty('disabled', true);
    expect(screen.getByTestId('machines-bulk-signout')).toHaveProperty('disabled', true);
  });

  it('select-all takes every shown card, and Escape clears', async () => {
    renderHome();
    await select(0);
    await userEvent.click(screen.getByTestId('machines-select-all'));
    expect(screen.getByTestId('machines-selection-count').textContent).toBe('3 selected');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('machines-selection-bar')).toBeNull();
    expect(screen.getByTestId('machine-filter')).toBeTruthy();
  });

  it('ctrl-click on a card toggles it without opening anything', async () => {
    renderHome();
    const user = userEvent.setup();
    await user.keyboard('{Control>}');
    await user.click(within(cards()[0]).getByTestId('sandbox-name'));
    await user.keyboard('{/Control}');
    expect(cards()[0].getAttribute('data-selected')).toBe('true');
    expect(screen.queryByTestId('sandbox-name-input')).toBeNull();
  });
});

describe('running a bulk action', () => {
  it('deletes every selected machine after the confirm', async () => {
    renderHome();
    await select(0);
    await select(2);
    await userEvent.click(screen.getByTestId('machines-bulk-delete'));
    expect(h.runBulkAction).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(h.runBulkAction).toHaveBeenCalledTimes(1);
    expect((h.runBulkAction.mock.calls[0] as unknown as [string, Array<{ id: string }>])[1].map((n) => n.id)).toEqual([
      'node-1',
      'node-3',
    ]);
    expect(screen.queryByTestId('machines-selection-bar')).toBeNull();
  });

  it('upgrades only the eligible machines and says how many are skipped', async () => {
    renderHome();
    await select(0);
    await select(1);
    await userEvent.click(screen.getByTestId('machines-bulk-upgrade'));
    expect(screen.getByText(/1 skipped: not started, unreachable or unavailable/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect((h.runBulkAction.mock.calls[0] as unknown as [string, Array<{ id: string }>])[1].map((n) => n.id)).toEqual([
      'node-1',
    ]);
  });
});

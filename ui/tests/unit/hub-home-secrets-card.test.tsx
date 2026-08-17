/**
 * HubHome's desktop card → Credentials.
 *
 * This button used to call `openDock` with a page-less MACHINE pointer, which
 * `pageRedirectUrl` bounced straight back to /dock/hub/home on a hub-only
 * server — so the button did nothing. The contract is `openPage(HUB, …)`, and
 * that is what this pins.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  openPage: vi.fn(),
  openDock: vi.fn(),
  projects: [] as Array<{ id: string; displayName: string }>,
  refetchProjects: vi.fn(),
  deleteEntity: vi.fn(() => Promise.resolve()),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, dataManager: { ...(actual.dataManager as object), delete: h.deleteEntity } };
});
vi.mock('@src/notifications', () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openPage: h.openPage, openDock: h.openDock },
    currentDock: { page: 'hub' },
  }),
  // The Projects section renders the shared ProjectActionsRow, which reaches
  // view-mode/home-surface hooks built on these.
  useCurrentDock: () => ({ page: 'hub' }),
  useIsHomeSurface: () => true,
}));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ currentUser: { id: 'u1', name: 'Ada' } }),
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: null }) }));
vi.mock('@src/hooks/use-projects', () => ({
  useProjects: () => ({ projects: h.projects, isLoading: false, refetch: h.refetchProjects }),
}));
vi.mock('@src/hooks/use-sandboxes', () => ({
  useSandboxes: () => ({
    // `node_provider_id` marks it as launched — the card branches on it to
    // choose between Open and Launch.
    sandboxes: [{ id: 'node-1', name: 'Sandbox One', node_provider_id: 'sbx-1' }],
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
    details: {},
  }),
  isLaunched: (node: { node_provider_id?: string }) => !!node.node_provider_id,
  nextSandboxName: () => 'Sandbox 2',
}));
vi.mock('@src/pages/hub-home/NewSandboxDialog', () => ({ NewSandboxDialog: () => null }));
vi.mock('@src/pages/hub-home/LaunchSandboxDialog', () => ({ LaunchSandboxDialog: () => null }));
// The token plan card runs a react-query hook; out of scope here.
vi.mock('@src/components/token-plan/TokenPlanCard', () => ({ TokenPlanCard: () => null }));

import { PageId, ViewType } from '@sdk';

import { TooltipProvider } from '@src/components/ui/tooltip';
import { HubHome } from '@src/pages/hub-home/HubHome';

describe('HubHome sandbox secrets button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.projects.length = 0;
  });
  afterEach(() => cleanup());

  it('opens Credentials on the hub page, never a page-less dock', async () => {
    // The New Sandbox button is wrapped in a Tooltip (it explains why creating
    // is disabled), and radix Tooltip throws outside a provider. The real app
    // gets one from the page shell; this test renders HubHome alone.
    render(
      <TooltipProvider>
        <HubHome />
      </TooltipProvider>,
    );

    await userEvent.click(screen.getByTestId('sandbox-secrets'));

    expect(h.openDock).not.toHaveBeenCalled();
    expect(h.openPage).toHaveBeenCalledWith(PageId.HUB, ViewType.CREDENTIALS, 'environment');
  });

  it('opens a project on its canonical Hub page', async () => {
    h.projects.push({ id: '12345678-0000-4000-8000-000000000000', displayName: 'Project One' });
    render(
      <TooltipProvider>
        <HubHome />
      </TooltipProvider>,
    );

    await userEvent.click(screen.getByText('Project One'));

    expect(h.openDock).toHaveBeenCalledOnce();
    expect(h.openDock.mock.calls[0][0].toUrl()).toBe('/dock/hub/project/12345678-0000-4000-8000-000000000000');
  });

  it('asks before deleting a project, and never on the way to opening one', async () => {
    h.projects.push({ id: '12345678-0000-4000-8000-000000000000', displayName: 'Project One' });
    render(
      <TooltipProvider>
        <HubHome />
      </TooltipProvider>,
    );

    await userEvent.click(screen.getByTestId('hub-project-delete'));

    // Nothing is destroyed on the click itself — the confirm is the gate.
    expect(h.deleteEntity).not.toHaveBeenCalled();
    expect(screen.getByText(/will be deleted for everyone/).textContent).toContain('Project One');

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // The hub has no `delete-with-children` action (that is a flow_sdk route),
    // so this must be the generic entity DELETE.
    expect(h.deleteEntity).toHaveBeenCalledOnce();
    const typeId = h.deleteEntity.mock.calls[0][0] as { type: string; id: string };
    expect(typeId.type).toBe('project');
    expect(typeId.id).toBe('12345678-0000-4000-8000-000000000000');
    // Deleting is not a navigation — the card's open path must not have fired.
    expect(h.openDock).not.toHaveBeenCalled();
  });

  it('backs out of the confirm without deleting', async () => {
    h.projects.push({ id: '12345678-0000-4000-8000-000000000000', displayName: 'Project One' });
    render(
      <TooltipProvider>
        <HubHome />
      </TooltipProvider>,
    );

    await userEvent.click(screen.getByTestId('hub-project-delete'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(h.deleteEntity).not.toHaveBeenCalled();
  });
});

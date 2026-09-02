/**
 * `CredentialsView` — the shell around the one credential surface.
 *
 * There is no tab bar any more: Connections is the only pane, and the retired
 * `environment` / `api-keys` subviews forward to it so old saved tabs and
 * bookmarks still land somewhere real. These are about WIRING, so the pane and
 * the project selector are stubbed: what matters is that navigation preserves
 * the page (openTab would silently drop it back to desk), that the selected
 * project reaches the pane, and that a logged-out user meets one guard.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  openPage: vi.fn(),
  openDock: vi.fn(),
  openTab: vi.fn(),
  pointer: 'environment' as string | undefined,
  page: 'hub' as string,
  user: { id: 'u1' } as { id: string } | null,
  contextProject: null as { id: string } | null,
  projects: [
    { id: 'proj-a', name: 'Alpha', typeId: 'project-a', fs_storage_mount_path: '/a' },
    { id: 'proj-b', name: 'Beta', typeId: 'project-b', fs_storage_mount_path: '/b' },
  ] as unknown[],
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openPage: h.openPage, openDock: h.openDock, openTab: h.openTab },
    currentDock: { page: h.page, pointer: h.pointer },
  }),
}));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ user: h.user }),
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: h.contextProject }) }));
vi.mock('@src/hooks/use-projects', () => ({
  useProjects: () => ({ projects: h.projects, isLoading: false, refetch: vi.fn() }),
}));
vi.mock('@src/components/connections-manager', () => ({
  ConnectionsManager: ({ projectTypeId }: { projectTypeId: unknown }) => (
    <div data-testid="pane-connections">{String(projectTypeId)}</div>
  ),
}));
vi.mock('@src/components/project-selector', () => ({
  ProjectSelector: ({ onSelect }: { onSelect: (id: string) => void }) => (
    <button data-testid="pick-proj-b" onClick={() => onSelect('proj-b')}>
      Beta
    </button>
  ),
}));

import { CredentialsView } from '@src/components/credentials-view/CredentialsView';

describe('CredentialsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.pointer = 'environment';
    h.page = 'hub';
    h.user = { id: 'u1' };
  });
  afterEach(() => cleanup());

  it('mounts Connections with the most recent project', () => {
    render(<CredentialsView />);

    expect(screen.getByTestId('pane-connections').textContent).toBe('project-a');
  });

  it('forwards a retired subview to Connections rather than blanking', () => {
    // `environment` and `api-keys` are still in the cross-language enum and
    // still reachable from persisted tabs, so they must land somewhere real.
    h.pointer = 'environment/proj-b';
    render(<CredentialsView />);

    expect(screen.getByTestId('pane-connections').textContent).toBe('project-b');
  });

  it('navigates on project pick, preserving the page', async () => {
    render(<CredentialsView />);

    await userEvent.click(screen.getByTestId('credentials-project-picker'));
    await userEvent.click(screen.getByTestId('pick-proj-b'));

    // openTab / openDock are desk-only and would silently drop page=hub.
    expect(h.openTab).not.toHaveBeenCalled();
    expect(h.openDock).not.toHaveBeenCalled();
    expect(h.openPage).toHaveBeenCalledWith('hub', 'credentials', 'connections/proj-b');
  });

  it('carries the page through even on desk', async () => {
    h.page = 'desk';
    render(<CredentialsView />);

    await userEvent.click(screen.getByTestId('credentials-project-picker'));
    await userEvent.click(screen.getByTestId('pick-proj-b'));

    expect(h.openPage).toHaveBeenCalledWith('desk', 'credentials', 'connections/proj-b');
  });

  it('reads the selected project from the pointer', () => {
    h.pointer = 'connections/proj-b';
    render(<CredentialsView />);

    expect(screen.getByTestId('pane-connections').textContent).toBe('project-b');
  });

  it('shows one login guard and no panes when logged out', () => {
    h.user = null;
    render(<CredentialsView />);

    expect(screen.getByTestId('login-required')).toBeTruthy();
    // The pane, not the retired ones — asserting testids that no longer exist
    // anywhere passes vacuously and guards nothing.
    expect(screen.queryByTestId('pane-connections')).toBeNull();
  });

  it('still mounts Connections with no project — a machine credential needs none', () => {
    // The old Environment pane demanded a project and showed a "no projects"
    // panel without one. Connections does not: an OAuth credential is
    // user-scoped, so the table has something to say either way. Only the
    // project-scoped credential rows go quiet.
    h.projects = [];
    render(<CredentialsView />);

    expect(screen.getByTestId('pane-connections')).toBeTruthy();
    expect(screen.getByTestId('pane-connections').textContent).toBe('undefined');
    h.projects = [
      { id: 'proj-a', name: 'Alpha', typeId: 'project-a', fs_storage_mount_path: '/a' },
      { id: 'proj-b', name: 'Beta', typeId: 'project-b', fs_storage_mount_path: '/b' },
    ];
  });
});

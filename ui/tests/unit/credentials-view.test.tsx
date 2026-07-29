/**
 * `CredentialsView` — the tabbed shell.
 *
 * These are about WIRING, so the three panes are stubbed: what matters is that
 * navigation preserves the page (openTab would silently drop it back to desk),
 * that the selected project reaches the Environment pane, and that a logged-out
 * user meets one guard rather than three.
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
vi.mock('@src/components/EnvVarsManager', () => ({
  EnvVarsManager: ({ entityTypeId }: { entityTypeId: unknown }) => (
    <div data-testid="pane-environment">{String(entityTypeId)}</div>
  ),
}));
vi.mock('@src/components/connections-manager', () => ({
  ConnectionsManager: ({ projectTypeId }: { projectTypeId: unknown }) => (
    <div data-testid="pane-connections">{String(projectTypeId)}</div>
  ),
}));
vi.mock('@src/components/api-keys-view/api-keys-view', () => ({
  ApiKeysView: () => <div data-testid="pane-api-keys" />,
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

  it('opens on Environment with the most recent project', () => {
    render(<CredentialsView />);

    expect(screen.getByTestId('pane-environment').textContent).toBe('project-a');
  });

  it('navigates on tab change, preserving the page', async () => {
    render(<CredentialsView />);

    await userEvent.click(screen.getByRole('tab', { name: /connections/i }));

    // openTab / openDock are desk-only and would silently drop page=hub.
    expect(h.openTab).not.toHaveBeenCalled();
    expect(h.openDock).not.toHaveBeenCalled();
    expect(h.openPage).toHaveBeenCalledWith('hub', 'credentials', 'connections/proj-a');
  });

  it('carries the page through even on desk', async () => {
    h.page = 'desk';
    render(<CredentialsView />);

    await userEvent.click(screen.getByRole('tab', { name: /api keys/i }));

    expect(h.openPage).toHaveBeenCalledWith('desk', 'credentials', 'api-keys/proj-a');
  });

  it('reads the selected project from the pointer', () => {
    h.pointer = 'connections/proj-b';
    render(<CredentialsView />);

    expect(screen.getByTestId('pane-connections').textContent).toBe('project-b');
  });

  it('hides the project picker on the user-scoped tab', () => {
    h.pointer = 'api-keys';
    render(<CredentialsView />);

    expect(screen.queryByTestId('credentials-project-picker')).toBeNull();
    expect(screen.getByTestId('pane-api-keys')).toBeTruthy();
  });

  it('shows one login guard and no panes when logged out', () => {
    h.user = null;
    render(<CredentialsView />);

    expect(screen.getByTestId('login-required')).toBeTruthy();
    expect(screen.queryByTestId('pane-environment')).toBeNull();
    expect(screen.queryByTestId('pane-api-keys')).toBeNull();
  });

  it('does not mount the env table with no project to scope it to', () => {
    h.projects = [];
    render(<CredentialsView />);

    expect(screen.queryByTestId('pane-environment')).toBeNull();
    expect(screen.getByTestId('credentials-no-project')).toBeTruthy();
    h.projects = [
      { id: 'proj-a', name: 'Alpha', typeId: 'project-a', fs_storage_mount_path: '/a' },
      { id: 'proj-b', name: 'Beta', typeId: 'project-b', fs_storage_mount_path: '/b' },
    ];
  });
});

/**
 * `CredentialsView` — the shell around the one credential surface.
 *
 * There is no tab bar any more: Connections is the only pane, and the retired
 * `environment` / `api-keys` subviews forward to it so old saved tabs and
 * bookmarks still land somewhere real. These are about WIRING, so the pane is
 * stubbed: what matters is that the project in the URL reaches the pane, that
 * there is no project picker (the app already selected one), and that a
 * logged-out user meets one guard.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  pointer: 'environment' as string | undefined,
  user: { id: 'u1' } as { id: string } | null,
  contextProject: null as { id: string } | null,
  projects: [
    { id: 'proj-a', name: 'Alpha', typeId: 'project-a', fs_storage_mount_path: '/a' },
    { id: 'proj-b', name: 'Beta', typeId: 'project-b', fs_storage_mount_path: '/b' },
  ] as unknown[],
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: {},
    currentDock: { pointer: h.pointer },
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

import { CredentialsView } from '@src/components/credentials-view/CredentialsView';

/** The view reads credentials through react-query (`use-credentials`), so it renders under a client. */
function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CredentialsView />
    </QueryClientProvider>,
  );
}

describe('CredentialsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.pointer = 'environment';
    h.user = { id: 'u1' };
    h.contextProject = null;
  });
  afterEach(() => cleanup());

  it('keeps personal connections unscoped even when recent projects exist', () => {
    renderView();

    expect(screen.getByTestId('pane-connections').textContent).toBe('undefined');
  });

  it('does not grant or test against a context project absent from the URL', () => {
    h.pointer = undefined;
    h.contextProject = { id: 'proj-b' };
    renderView();

    expect(screen.getByTestId('pane-connections').textContent).toBe('undefined');
  });

  it('does not substitute a recent project for an unresolved URL project', () => {
    h.pointer = 'connections/missing-project';
    renderView();

    expect(screen.getByTestId('pane-connections').textContent).toBe('undefined');
  });

  it('forwards a retired subview to Connections rather than blanking', () => {
    // `environment` and `api-keys` are still in the cross-language enum and
    // still reachable from persisted tabs, so they must land somewhere real.
    h.pointer = 'environment/proj-b';
    renderView();

    expect(screen.getByTestId('pane-connections').textContent).toBe('project-b');
  });

  it('has no project picker — the project is the one the app already selected, carried in the URL', () => {
    h.pointer = 'connections/proj-b';
    renderView();

    expect(screen.queryByTestId('credentials-project-picker')).toBeNull();
    expect(screen.getByTestId('pane-connections').textContent).toBe('project-b');
  });

  it('reads the selected project from the pointer', () => {
    h.pointer = 'connections/proj-b';
    renderView();

    expect(screen.getByTestId('pane-connections').textContent).toBe('project-b');
  });

  it('shows one login guard and no panes when logged out', () => {
    h.user = null;
    renderView();

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
    renderView();

    expect(screen.getByTestId('pane-connections')).toBeTruthy();
    expect(screen.getByTestId('pane-connections').textContent).toBe('undefined');
    h.projects = [
      { id: 'proj-a', name: 'Alpha', typeId: 'project-a', fs_storage_mount_path: '/a' },
      { id: 'proj-b', name: 'Beta', typeId: 'project-b', fs_storage_mount_path: '/b' },
    ];
  });
});

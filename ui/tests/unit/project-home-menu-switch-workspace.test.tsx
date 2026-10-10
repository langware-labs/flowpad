/**
 * ProjectHomeMenu — the Project Home burger's "Switch workspace": lists every
 * workspace with the project's own one disabled, warns before moving, calls
 * `Project.switchWorkspace`, and navigates to the project INSIDE the new workspace
 * (`?workspace=` on the pointer — the loader drops a project outside the URL's
 * workspace). A refused move (409: the destination has that name) is shown, and
 * nothing navigates.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Project } from '@sdk';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above the imports, so everything they close over
// is created in `vi.hoisted` (plain rows: the SDK helpers only read fields).
const { openProjectInWorkspace, reload, notify, workspaces, DEFAULT_ID, CLIENT_ID } = vi.hoisted(() => {
  const DEFAULT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CLIENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  return {
    openProjectInWorkspace: vi.fn(),
    reload: vi.fn(async () => undefined),
    notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    DEFAULT_ID,
    CLIENT_ID,
    workspaces: [
      { id: DEFAULT_ID, name: 'Local Desktop Workspace', is_default: true, root: 'Users/me/Flowpad workspace' },
      { id: CLIENT_ID, name: 'Client X', root_path: '/Users/me/Flowpad/Client X', root: 'Users/me/Flowpad/Client X' },
    ],
  };
});
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openProjectInWorkspace } }),
  useCurrentDock: () => null,
}));
vi.mock('@src/hooks/use-workspaces', () => ({
  useActiveWorkspace: () => ({ workspaces, workspace: workspaces[0], hasMany: true, scopeId: undefined, root: '', reload }),
}));
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ computeNode: { id: 'node-1' }, desktopInfo: { paths: { root: '/' } } }),
}));
vi.mock('@src/notifications', () => ({ notify }));
vi.mock('@sdk/lazy', () => ({ lazyAssets: { invalidate: vi.fn() }, LazyAsset: { DiscoveredProjects: 'discovered-projects' } }));

const PROJECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

import { ProjectHomeMenu } from '@src/components/project-home/ProjectHomeMenu';

function project(): Project {
  return new Project({ id: PROJECT_ID, name: 'repo', fs_storage_mount_path: '/Users/me/Flowpad workspace/repo' });
}

/** Open the burger, then the submenu the way Radix opens one in jsdom: focus + ArrowRight. */
async function openSwitchSubmenu() {
  await userEvent.setup().click(screen.getByTestId('project-home-menu'));
  const trigger = await screen.findByTestId('project-home-switch-workspace');
  act(() => {
    trigger.focus();
  });
  fireEvent.keyDown(trigger, { key: 'ArrowRight' });
}

/** Pick a workspace row, then confirm the warning dialog. */
async function pickAndConfirm(workspaceTestId: string) {
  fireEvent.click(await screen.findByTestId(workspaceTestId));
  fireEvent.click(await screen.findByTestId('switch-workspace-confirm'));
}

describe('ProjectHomeMenu — Switch workspace', () => {
  beforeEach(() => {
    openProjectInWorkspace.mockReset();
    reload.mockClear();
    notify.success.mockReset();
    notify.error.mockReset();
    notify.warning.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists every workspace, with the one the project is in disabled', async () => {
    render(<ProjectHomeMenu project={project()} />);
    await openSwitchSubmenu();

    const current = await screen.findByTestId('project-home-workspace-default');
    expect(current.getAttribute('data-disabled')).not.toBeNull();
    expect(screen.getByTestId(`project-home-workspace-${CLIENT_ID}`).getAttribute('data-disabled')).toBeNull();
    expect(screen.getByTestId('project-home-workspace-new')).toBeTruthy();
  });

  it('warns, moves, and opens the project inside the new workspace', async () => {
    const moved = project();
    moved.fs_storage_mount_path = '/Users/me/Flowpad/Client X/repo';
    const switchWorkspace = vi
      .spyOn(Project, 'switchWorkspace')
      .mockResolvedValue({ project: moved, path: '/Users/me/Flowpad/Client X/repo', previousPath: '/Users/me/Flowpad workspace/repo', indexed: true });

    render(<ProjectHomeMenu project={project()} />);
    await openSwitchSubmenu();
    fireEvent.click(await screen.findByTestId(`project-home-workspace-${CLIENT_ID}`));

    const dialog = await screen.findByTestId('switch-workspace-dialog');
    expect(dialog.textContent).toContain('Every open tab and running process of this project will be closed');
    expect(screen.getByTestId('switch-workspace-destination').textContent).toContain('/Users/me/Flowpad/Client X/repo');
    expect(switchWorkspace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('switch-workspace-confirm'));

    await waitFor(() => expect(openProjectInWorkspace).toHaveBeenCalledTimes(1));
    expect(switchWorkspace).toHaveBeenCalledWith('node-1', PROJECT_ID, CLIENT_ID);
    expect(openProjectInWorkspace).toHaveBeenCalledWith(PROJECT_ID, CLIENT_ID);
    expect(reload).toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalled();
  });

  it('moving to the default workspace sends no workspace id and clears the URL param', async () => {
    const elsewhere = project();
    elsewhere.fs_storage_mount_path = '/Users/me/Flowpad/Client X/repo';
    const switchWorkspace = vi
      .spyOn(Project, 'switchWorkspace')
      .mockResolvedValue({ project: elsewhere, path: '/Users/me/Flowpad workspace/repo', previousPath: '/Users/me/Flowpad/Client X/repo', indexed: true });

    render(<ProjectHomeMenu project={elsewhere} />);
    await openSwitchSubmenu();
    await pickAndConfirm('project-home-workspace-default');

    await waitFor(() => expect(openProjectInWorkspace).toHaveBeenCalledTimes(1));
    expect(switchWorkspace).toHaveBeenCalledWith('node-1', PROJECT_ID, undefined);
    // `null`: the default workspace — the sticky param is cleared, not carried forward.
    expect(openProjectInWorkspace).toHaveBeenCalledWith(PROJECT_ID, null);
  });

  it('a refused move (destination has that name) is shown and nothing navigates', async () => {
    vi.spyOn(Project, 'switchWorkspace').mockRejectedValue({
      response: { status: 409, data: { message: "'repo' already exists in that workspace" } },
    });

    render(<ProjectHomeMenu project={project()} />);
    await openSwitchSubmenu();
    await pickAndConfirm(`project-home-workspace-${CLIENT_ID}`);

    await waitFor(() => expect(notify.error).toHaveBeenCalledTimes(1));
    expect(notify.error.mock.calls[0][0].message).toContain("'repo' already exists in that workspace");
    expect(openProjectInWorkspace).not.toHaveBeenCalled();
    expect(screen.getByTestId('switch-workspace-dialog')).toBeTruthy();
  });
});

describe('ProjectHomeMenu — moved but not indexed', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('a move whose index did not run still navigates, and warns instead of celebrating', async () => {
    openProjectInWorkspace.mockReset();
    notify.warning.mockReset();
    notify.success.mockReset();
    const moved = project();
    moved.fs_storage_mount_path = '/Users/me/Flowpad/Client X/repo';
    vi.spyOn(Project, 'switchWorkspace').mockResolvedValue({
      project: moved,
      path: '/Users/me/Flowpad/Client X/repo',
      previousPath: '/Users/me/Flowpad workspace/repo',
      indexed: false,
    });

    render(<ProjectHomeMenu project={project()} />);
    await openSwitchSubmenu();
    await pickAndConfirm(`project-home-workspace-${CLIENT_ID}`);

    await waitFor(() => expect(openProjectInWorkspace).toHaveBeenCalledTimes(1));
    expect(notify.warning).toHaveBeenCalledTimes(1);
    expect(notify.success).not.toHaveBeenCalled();
  });
});

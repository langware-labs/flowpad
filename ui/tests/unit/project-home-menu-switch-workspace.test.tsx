/**
 * ProjectHomeMenu — the Project Home burger's "Switch workspace": lists every
 * workspace with the project's own one disabled, warns before moving, calls
 * `project.switchWorkspace`, and opens the project INSIDE the new workspace (the
 * loader drops a project outside the URL's workspace). A refused move (409: the
 * destination has that name) is shown, and nothing navigates.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Project } from '@sdk';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above the imports, so everything they close over
// is created in `vi.hoisted` (plain rows: the SDK helpers only read fields).
const { openProjectInWorkspace, reload, notify, workspaces, CLIENT_ID } = vi.hoisted(() => {
  const CLIENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  return {
    openProjectInWorkspace: vi.fn(),
    reload: vi.fn(async () => undefined),
    notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
    CLIENT_ID,
    workspaces: [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Local', is_default: true, root: 'Users/me/Flowpad workspace' },
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

import { ProjectHomeMenu } from '@src/components/project-home/ProjectHomeMenu';

const PROJECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const IN_DEFAULT = '/Users/me/Flowpad workspace/repo';
const IN_CLIENT = '/Users/me/Flowpad/Client X/repo';

function projectAt(path: string): Project {
  return new Project({ id: PROJECT_ID, name: 'repo', fs_storage_mount_path: path });
}

/** The move as the SDK method: resolves with `indexed`, or rejects with the backend's refusal. */
function switchWorkspace() {
  return vi.spyOn(Project.prototype, 'switchWorkspace');
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

/** Render the menu for a project, pick a workspace row, confirm the warning dialog. */
async function move(from: string, workspaceTestId: string) {
  render(<ProjectHomeMenu project={projectAt(from)} />);
  await openSwitchSubmenu();
  fireEvent.click(await screen.findByTestId(workspaceTestId));
  fireEvent.click(await screen.findByTestId('switch-workspace-confirm'));
}

describe('ProjectHomeMenu — Switch workspace', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('lists every workspace, with the one the project is in disabled', async () => {
    render(<ProjectHomeMenu project={projectAt(IN_DEFAULT)} />);
    await openSwitchSubmenu();

    expect((await screen.findByTestId('workspace-item-default')).getAttribute('data-disabled')).not.toBeNull();
    expect(screen.getByTestId(`workspace-item-${CLIENT_ID}`).getAttribute('data-disabled')).toBeNull();
    expect(screen.getByTestId('workspace-new')).toBeTruthy();
  });

  it('warns before anything happens, then moves and opens the project inside the new workspace', async () => {
    const moved = switchWorkspace().mockResolvedValue({ indexed: true });
    render(<ProjectHomeMenu project={projectAt(IN_DEFAULT)} />);
    await openSwitchSubmenu();
    fireEvent.click(await screen.findByTestId(`workspace-item-${CLIENT_ID}`));

    const dialog = await screen.findByTestId('switch-workspace-dialog');
    expect(dialog.textContent).toContain('Every open tab and running process of this project will be closed');
    expect(screen.getByTestId('switch-workspace-destination').textContent).toContain(IN_CLIENT);
    expect(moved).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('switch-workspace-confirm'));

    await waitFor(() => expect(openProjectInWorkspace).toHaveBeenCalledWith(PROJECT_ID, CLIENT_ID));
    expect(moved).toHaveBeenCalledWith(CLIENT_ID);
    expect(reload).toHaveBeenCalled();
    expect(notify.success).toHaveBeenCalled();
  });

  it('moving to the default workspace sends no workspace id and clears the URL param', async () => {
    const moved = switchWorkspace().mockResolvedValue({ indexed: true });
    await move(IN_CLIENT, 'workspace-item-default');

    // `null`: the default workspace — the sticky param is cleared, not carried forward.
    await waitFor(() => expect(openProjectInWorkspace).toHaveBeenCalledWith(PROJECT_ID, null));
    expect(moved).toHaveBeenCalledWith(undefined);
  });

  it('a move whose index did not run still navigates, and warns instead of celebrating', async () => {
    switchWorkspace().mockResolvedValue({ indexed: false });
    await move(IN_DEFAULT, `workspace-item-${CLIENT_ID}`);

    await waitFor(() => expect(openProjectInWorkspace).toHaveBeenCalledTimes(1));
    expect(notify.warning).toHaveBeenCalledTimes(1);
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('a refused move (destination has that name) is shown and nothing navigates', async () => {
    switchWorkspace().mockRejectedValue({
      response: { status: 409, data: { message: "'repo' already exists in that workspace" } },
    });
    await move(IN_DEFAULT, `workspace-item-${CLIENT_ID}`);

    await waitFor(() => expect(notify.error).toHaveBeenCalledTimes(1));
    expect(notify.error.mock.calls[0][0].message).toContain("'repo' already exists in that workspace");
    expect(openProjectInWorkspace).not.toHaveBeenCalled();
    expect(screen.getByTestId('switch-workspace-dialog')).toBeTruthy();
  });
});

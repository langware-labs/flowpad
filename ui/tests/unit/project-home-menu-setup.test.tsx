/**
 * ProjectHomeMenu — the burger's first entry, "Project setup": it only navigates (URL-first) to the
 * project's setup page, and says "N left" while the project owes setup.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Project, refreshProjectReadiness, setProjectReadiness } from '@sdk';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { openDock } = vi.hoisted(() => ({ openDock: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ currentDock: null, navigation: { openDock } }),
  useCurrentDock: () => null,
}));
vi.mock('@src/hooks/use-workspaces', () => ({
  useActiveWorkspace: () => ({
    workspaces: [],
    workspace: null,
    hasMany: false,
    scopeId: undefined,
    root: '',
    reload: vi.fn(),
  }),
}));
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ computeNode: { id: 'node-1' }, desktopInfo: { paths: { root: '/' } } }),
}));

import { ProjectHomeMenu } from '@src/components/project-home/ProjectHomeMenu';

const PROJECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const project = () => new Project({ id: PROJECT_ID, name: 'repo', fs_storage_mount_path: '/w/repo' });
/** The footer's readiness store, answering for this project with `n` things left. */
const owing = async (n: number) => {
  vi.spyOn(Project, 'setupRequirements').mockRejectedValue(new Error('no backend'));
  await refreshProjectReadiness(PROJECT_ID);
  setProjectReadiness({
    project_id: PROJECT_ID,
    ready: n === 0,
    to_do: Array.from({ length: n }, (_, i) => ({ name: `c${i}` }) as never),
    gaps: [],
  });
};

async function openMenu() {
  render(<ProjectHomeMenu project={project()} />);
  await userEvent.setup().click(screen.getByTestId('project-home-menu'));
  return screen.findByTestId('project-home-setup');
}

describe('ProjectHomeMenu — Project setup', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('is the first entry and opens the setup page by URL only', async () => {
    await owing(0);
    const item = await openMenu();
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toBe(item);
    await userEvent.setup().click(item);
    expect(openDock).toHaveBeenCalledTimes(1);
    expect(openDock.mock.calls[0][0].toUrl?.() ?? String(openDock.mock.calls[0][0].pointer)).toContain(
      `${PROJECT_ID}/project-setup`,
    );
  });

  it('says how many steps are left while setup is owed, and nothing once ready', async () => {
    await owing(2);
    await openMenu();
    expect(screen.getByTestId('project-home-setup-left').textContent).toBe('2 left');
    cleanup();
    await owing(0);
    await openMenu();
    expect(screen.queryByTestId('project-home-setup-left')).toBeNull();
  });
});

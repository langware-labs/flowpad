/**
 * U8 (R12) — the auto-popup for shared projects is gone; the template deep link
 * that shares its dialog still works.
 *
 * A shared project is offered only by the Install project chip on the invite
 * message (`ProjectInstallChip`). The watcher that raised the "X shared a
 * project with you" dialog for every uninstalled shared row is deleted, and
 * `App` no longer mounts it. What stays is the `?action=open&setup_git=1` deep
 * link: `IncomingDeepLink` fills the pending-project slot and the dialog clones
 * the template into a fresh project.
 *
 * Drives the REAL `IncomingDeepLink` → store → `IncomingProjectDialog` chain;
 * the stand-ins are the boundaries only: the router shortcut, the agent layout's
 * compute node, and the clone-and-open hook (the server-side clone).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitOrigin } from '@sdk';

const h = vi.hoisted(() => ({
  openDock: vi.fn(),
  cloneGitProject: vi.fn(),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: h.openDock }, currentDock: null }),
}));

vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ computeNode: { id: 'compute_node-local' } }),
}));

vi.mock('@src/components/project-selector', () => ({
  useCloneGitProjectAndOpen: () => h.cloneGitProject,
}));

import appSource from '@src/App.tsx?raw';
import { IncomingDeepLink } from '@src/components/task-receive/IncomingDeepLink';
import { useIncomingProjectStore } from '@src/store/use-incoming-project-store';

const ORIGIN: GitOrigin = {
  kind: 'git',
  provider: 'github',
  owner: 'acme',
  name: 'course',
  branch: 'main',
  // The deep link only accepts a complete origin: a non-empty, safe position.
  rel_path: '.',
} as GitOrigin;

function landOn(params: Record<string, string>) {
  window.history.replaceState(null, '', `/?${new URLSearchParams(params).toString()}`);
}

describe('shared-project popup removed (R12)', () => {
  it('the watcher module is deleted and App does not mount it', () => {
    const taskReceive = Object.keys(import.meta.glob('/src/components/task-receive/*.{ts,tsx}'));
    expect(taskReceive.some((p) => p.includes('use-incoming-shared-projects'))).toBe(false);
    expect(appSource).not.toMatch(/IncomingSharedProjects|use-incoming-shared-projects/);
    // The deep-link landing is still app-level.
    expect(appSource).toMatch(/<IncomingDeepLink \/>/);
  });
});

describe('template deep link still opens the clone dialog', () => {
  beforeEach(() => {
    h.openDock.mockReset();
    h.cloneGitProject.mockReset();
    useIncomingProjectStore.getState().setPendingProject(null);
  });
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('sets the pending project from the link, scrubs the URL, and clones the template on confirm', async () => {
    h.cloneGitProject.mockResolvedValue({ kind: 'ok', project: { id: 'p-new' } });
    landOn({
      action: 'open',
      setup_git: '1',
      title: 'Course',
      sender_name: 'Alice',
      git_origin: JSON.stringify(ORIGIN),
    });

    render(<IncomingDeepLink />);

    // The slot holds exactly the template payload — no shared-project id.
    expect(useIncomingProjectStore.getState().pendingProject).toEqual({
      gitOrigin: ORIGIN,
      projectName: 'Course',
      senderName: 'Alice',
    });
    expect(window.location.search).toBe('');

    const dialog = await screen.findByTestId('incoming-project-dialog');
    expect(dialog.textContent).toContain('Alice');
    expect(dialog.textContent).toContain('Course');

    fireEvent.click(screen.getByTestId('incoming-project-install'));
    await waitFor(() => expect(h.cloneGitProject).toHaveBeenCalledTimes(1));
    expect(h.cloneGitProject).toHaveBeenCalledWith('compute_node-local', 'https://github.com/acme/course.git', {
      targetName: undefined,
      branch: 'main',
    });
  });
});

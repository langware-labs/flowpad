/**
 * Launching a sandbox with a project and asset packages.
 *
 * The dialog decides WHAT the launch will do; the pipeline turns that into
 * computeNodeTools calls. So what matters here is the payload it hands over:
 * the sandbox project (the one you're working on unless you change it), and the
 * assets that become context folders of it.
 *
 * It must also not probe repo access. `/api/v1/git/remote-access` is a flow_sdk
 * route the hub doesn't register, so the old probe 404'd for every repo and
 * demanded a GitHub connection for public ones.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  onLaunch: vi.fn(),
  githubStatus: vi.fn(() => Promise.resolve(true)),
  repoAccess: vi.fn(() => Promise.resolve({ hasAccess: true })),
}));

vi.mock('@src/lib/github-oauth-status', () => ({ fetchGithubStatus: h.githubStatus }));
vi.mock('@src/utils/gitUtils', () => ({ hasGitHubRepoAccess: h.repoAccess }));
vi.mock('@sdk/react/hooks', () => ({ useOAuthFlowComplete: () => undefined }));

import { NewDesktopDialog } from '@src/pages/hub-home/NewDesktopDialog';

const withRepo = {
  id: 'p-hub',
  name: 'flowpad-hub',
  git_origin: { provider: 'github', owner: 'langware-labs', name: 'flowpad-hub', branch: 'main', rel_path: '.' },
} as never;

const desk = {
  id: 'p-desk',
  name: 'acme-support',
  git_origin: { provider: 'github', owner: 'acme', name: 'acme-support', branch: 'main', rel_path: '.' },
} as never;

const repoLess = { id: 'p-notes', name: 'scratch-notes', git_origin: null } as never;

function renderDialog(props: Record<string, unknown> = {}) {
  return render(
    <NewDesktopDialog
      open
      onOpenChange={() => {}}
      defaultName="Desktop 3"
      currentProject={withRepo}
      projects={[withRepo, desk, repoLess]}
      onLaunch={h.onLaunch}
      {...props}
    />,
  );
}

/** The one payload everything here is about. */
function launched() {
  return h.onLaunch.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.githubStatus.mockResolvedValue(true);
});

afterEach(() => cleanup());

describe('new desktop: project + asset packages', () => {
  it('opens on the project you are working on, without being asked', async () => {
    renderDialog();

    expect(within(screen.getByTestId('sandbox-project-row')).getByText('flowpad-hub')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('launch-desktop'));

    expect(launched().sandboxProject).toMatchObject({
      name: 'flowpad-hub',
      projectId: 'p-hub',
      gitOrigin: expect.objectContaining({ name: 'flowpad-hub' }),
    });
  });

  it('carries an added asset package as a context project', async () => {
    renderDialog();

    await userEvent.click(screen.getByTestId('add-asset-package'));
    await userEvent.click(screen.getByRole('button', { name: /acme-support/ }));
    await userEvent.click(screen.getByTestId('launch-desktop'));

    expect(launched().sandboxProject.contextProjects).toEqual([
      expect.objectContaining({ name: 'acme-support', scope: 'shared' }),
    ]);
  });

  it('does not offer a project with no repository as an asset', async () => {
    renderDialog();

    await userEvent.click(screen.getByTestId('add-asset-package'));

    const picker = screen.getByTestId('source-picker');
    expect(within(picker).queryByText('scratch-notes')).not.toBeInTheDocument();
    expect(within(picker).getByText('acme-support')).toBeInTheDocument();
  });

  it('still lets a project with no repository BE the sandbox project', async () => {
    renderDialog();

    await userEvent.click(screen.getByTestId('change-sandbox-project'));
    await userEvent.click(screen.getByRole('button', { name: /scratch-notes/ }));
    await userEvent.click(screen.getByTestId('launch-desktop'));

    const { sandboxProject } = launched();
    expect(sandboxProject).toMatchObject({ name: 'scratch-notes', projectId: 'p-notes' });
    // No origin → the box mounts it empty instead of cloning.
    expect(sandboxProject.gitOrigin).toBeUndefined();
  });

  it('accepts a repo URL for the sandbox project', async () => {
    renderDialog({ currentProject: null, projects: [] });

    await userEvent.click(screen.getByTestId('change-sandbox-project'));
    await userEvent.type(screen.getByTestId('source-git-url'), 'https://github.com/octocat/Hello-World');
    await userEvent.click(screen.getByRole('button', { name: 'Use' }));
    await userEvent.click(screen.getByTestId('launch-desktop'));

    expect(launched().sandboxProject).toMatchObject({
      name: 'Hello-World',
      gitOrigin: expect.objectContaining({ owner: 'octocat' }),
    });
  });

  it('an asset can be removed before launching', async () => {
    renderDialog();

    await userEvent.click(screen.getByTestId('add-asset-package'));
    await userEvent.click(screen.getByRole('button', { name: /acme-support/ }));
    await userEvent.click(screen.getByRole('button', { name: /Remove acme-support/ }));
    await userEvent.click(screen.getByTestId('launch-desktop'));

    expect(launched().sandboxProject.contextProjects).toBeUndefined();
  });

  it('launches a plain desktop when there is no project at all', async () => {
    renderDialog({ currentProject: null, projects: [] });

    await userEvent.click(screen.getByTestId('launch-desktop'));

    expect(launched()).toEqual({ name: 'Desktop 3' });
  });

  it('never probes repo access — that route 404s on the hub', async () => {
    renderDialog();

    await userEvent.click(screen.getByTestId('change-sandbox-project'));
    await userEvent.type(screen.getByTestId('source-git-url'), 'https://github.com/octocat/Hello-World');
    await userEvent.click(screen.getByRole('button', { name: 'Use' }));
    await userEvent.click(screen.getByTestId('launch-desktop'));

    expect(h.repoAccess).not.toHaveBeenCalled();
    expect(launched().sandboxProject.gitOrigin).toBeDefined();
  });

  it('offers the GitHub connection only when there is not one', async () => {
    h.githubStatus.mockResolvedValue(false);
    renderDialog();

    expect(await screen.findByText(/connect GitHub to use private repos/i)).toBeInTheDocument();
  });
});

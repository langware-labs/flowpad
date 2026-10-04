/**
 * `ProjectGitShareToggle` — "Share git with project members" on the project page.
 *
 * Shown for a project whose folder has a GitHub origin, usable once the project is
 * linked to the cloud. Checking it shares the repo, or walks through the GitHub
 * step the hub asks for (install the App, connect GitHub) with "check again";
 * unchecking stops sharing. The Project verbs are spies; the hook and component
 * are the real ones.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitShare, Project } from '@sdk';

import { ProjectGitShareToggle } from '@src/components/project-home/ProjectGitShareToggle';
import { TooltipProvider } from '@src/components/ui/tooltip';

const CLONE_URL = 'https://app.flowpad.test/api/v1/graph/git_repo/77/git';
const INSTALL_URL = 'https://github.com/apps/flowpad/installations/new';

const share = (status: GitShare['status'], extra: Partial<GitShare> = {}): GitShare => ({
  status,
  repo: 'acme/api',
  git_repo: null,
  clone_url: null,
  install_url: null,
  default_branch: 'main',
  ...extra,
});

const mocks = vi.hoisted(() => ({
  origin: { provider: 'github', owner: 'acme', name: 'api', rel_path: '.' } as Record<string, string> | null,
  openExternal: vi.fn(),
  project: {
    id: '004f3ab7-d33b-48c0-ae0e-6e61e181a343',
    typeId: { type: 'project', id: '004f3ab7-d33b-48c0-ae0e-6e61e181a343', toString: () => 'project-004f3ab7' },
    remote: true,
    gitShare: vi.fn(),
    shareGit: vi.fn(),
    unshareGit: vi.fn(),
  },
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return { ...actual, cloudManager: { cloudAppUrl: 'https://app.flowpad.test' } };
});

vi.mock('@src/hooks/use-git-share-preflight', () => ({
  useGitSharePreflight: () => ({ origin: mocks.origin, refetch: vi.fn() }),
}));

vi.mock('@src/lib/open-external', () => ({ openExternal: mocks.openExternal }));

function renderToggle() {
  return render(
    <TooltipProvider>
      <ProjectGitShareToggle project={mocks.project as unknown as Project} />
    </TooltipProvider>,
  );
}

const checkbox = () => screen.getByTestId('project-git-share-checkbox');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.origin = { provider: 'github', owner: 'acme', name: 'api', rel_path: '.' };
  mocks.project.remote = true;
  mocks.project.gitShare.mockResolvedValue(share('not_shared'));
  mocks.project.unshareGit.mockResolvedValue(share('not_shared'));
});
afterEach(() => cleanup());

describe('ProjectGitShareToggle', () => {
  it('is not offered for a folder without a GitHub origin', () => {
    mocks.origin = { provider: 'gitlab', owner: 'acme', name: 'api', rel_path: '.' };
    renderToggle();
    expect(screen.queryByTestId('project-git-share')).toBeNull();
  });

  it('waits for the cloud link: disabled, says why, asks the hub nothing', async () => {
    mocks.project.remote = false;
    renderToggle();
    expect(checkbox()).toBeDisabled();
    await userEvent.hover(checkbox().closest('label')!);
    expect(await screen.findAllByText(/Link the project to the cloud first/)).not.toHaveLength(0);
    expect(mocks.project.gitShare).not.toHaveBeenCalled();
  });

  it('shows the current share: checked, with the members clone URL', async () => {
    mocks.project.gitShare.mockResolvedValue(share('shared', { clone_url: CLONE_URL }));
    renderToggle();
    await waitFor(() => expect(checkbox()).toHaveAttribute('data-state', 'checked'));
    expect(screen.getByTestId('project-git-share-copy')).toHaveAttribute('title', CLONE_URL);
  });

  it('walks through installing the GitHub App, then shares on "check again"', async () => {
    mocks.project.shareGit
      .mockResolvedValueOnce(share('install_required', { install_url: INSTALL_URL }))
      .mockResolvedValueOnce(share('shared', { clone_url: CLONE_URL }));
    renderToggle();
    await waitFor(() => expect(checkbox()).not.toBeDisabled());

    await userEvent.click(checkbox());
    expect(mocks.openExternal).toHaveBeenCalledWith(INSTALL_URL);
    expect(await screen.findByTestId('project-git-share-step')).toHaveTextContent('acme/api');

    await userEvent.click(screen.getByText('check again'));
    await waitFor(() => expect(checkbox()).toHaveAttribute('data-state', 'checked'));
    expect(mocks.project.shareGit).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('project-git-share-step')).toBeNull();
  });

  it('sends the person to connect GitHub on the hub when the hub cannot check them', async () => {
    mocks.project.shareGit.mockResolvedValue(share('github_connect_required'));
    renderToggle();
    await waitFor(() => expect(checkbox()).not.toBeDisabled());
    await userEvent.click(checkbox());

    await userEvent.click(await screen.findByText('Open connections'));
    expect(mocks.openExternal).toHaveBeenCalledWith('https://app.flowpad.test/dock/hub/credentials/connections');
  });

  it('a public repo needs no share', async () => {
    mocks.project.shareGit.mockResolvedValue(share('not_private'));
    renderToggle();
    await waitFor(() => expect(checkbox()).not.toBeDisabled());
    await userEvent.click(checkbox());
    expect(await screen.findByText('Public repos are already open to everyone.')).toBeInTheDocument();
    expect(checkbox()).toHaveAttribute('data-state', 'unchecked');
  });

  it('unchecking stops sharing', async () => {
    mocks.project.gitShare.mockResolvedValue(share('shared', { clone_url: CLONE_URL }));
    renderToggle();
    await waitFor(() => expect(checkbox()).toHaveAttribute('data-state', 'checked'));
    await userEvent.click(checkbox());
    expect(mocks.project.unshareGit).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(checkbox()).toHaveAttribute('data-state', 'unchecked'));
  });

  it('shows a refusal in the backend’s words', async () => {
    mocks.project.shareGit.mockRejectedValue({
      response: { data: { message: 'only an admin of acme/api on GitHub can share it' } },
    });
    renderToggle();
    await waitFor(() => expect(checkbox()).not.toBeDisabled());
    await userEvent.click(checkbox());
    expect(await screen.findByRole('alert')).toHaveTextContent('only an admin of acme/api on GitHub can share it');
  });
});

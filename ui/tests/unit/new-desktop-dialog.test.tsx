/**
 * Launching a desktop with a project and asset packages.
 *
 * The dialog decides WHAT the launch will do; the pipeline turns that into
 * computeNodeTools calls. So what matters here is the payload it hands over:
 * the project it loads (the one you're working on unless you change it), and
 * the assets that become context folders of it.
 *
 * Both fields are the same control, so each test that drives one is also
 * covering the other's behaviour.
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
  connect: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('@src/lib/github-oauth-status', () => ({ fetchGithubStatus: h.githubStatus }));
vi.mock('@sdk/react/hooks', () => ({ useOAuthFlowComplete: () => undefined }));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, oauthService: { connect: h.connect } };
});

import { NewDesktopDialog } from '@src/pages/hub-home/NewDesktopDialog';

// `displayName` is what the shared project picker renders (project-items.ts).
const withRepo = {
  id: 'p-hub',
  name: 'flowpad-hub',
  displayName: 'flowpad-hub',
  git_origin: { provider: 'github', owner: 'langware-labs', name: 'flowpad-hub', branch: 'main', rel_path: '.' },
} as never;

const desk = {
  id: 'p-desk',
  name: 'acme-support',
  displayName: 'acme-support',
  git_origin: { provider: 'github', owner: 'acme', name: 'acme-support', branch: 'main', rel_path: '.' },
} as never;

const repoLess = { id: 'p-notes', name: 'scratch-notes', displayName: 'scratch-notes', git_origin: null } as never;

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
  it('loads the project you are working on, without being asked', async () => {
    renderDialog();

    expect(within(screen.getByTestId('loaded-project-values')).getByText('flowpad-hub')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('launch-desktop'));

    expect(launched().sandboxProject).toMatchObject({
      name: 'flowpad-hub',
      projectId: 'p-hub',
      gitOrigin: expect.objectContaining({ name: 'flowpad-hub' }),
    });
  });

  it('carries an added asset package as a context project', async () => {
    renderDialog();

    await userEvent.click(screen.getByTestId('assets-chip-project'));
    await userEvent.click(screen.getByRole('button', { name: /acme-support/ }));
    await userEvent.click(screen.getByTestId('launch-desktop'));

    expect(launched().sandboxProject.contextProjects).toEqual([
      expect.objectContaining({ name: 'acme-support', scope: 'shared' }),
    ]);
  });

  it('does not offer a project with no repository as an asset', async () => {
    renderDialog();

    await userEvent.click(screen.getByTestId('assets-chip-project'));

    const list = screen.getByTestId('assets-projects');
    expect(within(list).queryByText('scratch-notes')).not.toBeInTheDocument();
    expect(within(list).getByText('acme-support')).toBeInTheDocument();
  });

  it('hides the project chip when there is nothing to choose between', () => {
    renderDialog({ projects: [withRepo] });

    // One project is already loaded — a "select project" list of one is noise.
    expect(screen.queryByTestId('loaded-project-chip-project')).not.toBeInTheDocument();
    // A git URL is still a way in.
    expect(screen.getByTestId('loaded-project-chip-url')).toBeInTheDocument();
  });

  it('opens each chip panel under its own field, one at a time', async () => {
    renderDialog();

    await userEvent.click(screen.getByTestId('loaded-project-chip-url'));
    expect(screen.getByTestId('loaded-project-url-input')).toBeInTheDocument();
    // The other field is untouched — the panels are per-field.
    expect(screen.queryByTestId('assets-url-input')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('loaded-project-chip-project'));
    expect(screen.queryByTestId('loaded-project-url-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('loaded-project-projects')).toBeInTheDocument();
  });

  it('still lets a project with no repository BE the sandbox project', async () => {
    renderDialog();

    await userEvent.click(screen.getByTestId('loaded-project-chip-project'));
    await userEvent.click(screen.getByRole('button', { name: /scratch-notes/ }));
    await userEvent.click(screen.getByTestId('launch-desktop'));

    const { sandboxProject } = launched();
    expect(sandboxProject).toMatchObject({ name: 'scratch-notes', projectId: 'p-notes' });
    // No origin → the box mounts it empty instead of cloning.
    expect(sandboxProject.gitOrigin).toBeUndefined();
  });

  it('accepts a repo URL for the project it loads', async () => {
    renderDialog({ currentProject: null, projects: [] });

    await userEvent.click(screen.getByTestId('loaded-project-chip-url'));
    await userEvent.type(screen.getByTestId('loaded-project-url-input'), 'https://github.com/octocat/Hello-World');
    await userEvent.click(screen.getByRole('button', { name: 'Use' }));
    await userEvent.click(screen.getByTestId('launch-desktop'));

    expect(launched().sandboxProject).toMatchObject({
      name: 'Hello-World',
      gitOrigin: expect.objectContaining({ owner: 'octocat' }),
    });
    // No access probe on the way: `/api/v1/git/remote-access` is a flow_sdk
    // route the hub doesn't register, so it 404s for every repo.
    expect(vi.mocked(h.connect)).not.toHaveBeenCalled();
  });

  it('an asset can be removed before launching', async () => {
    renderDialog();

    await userEvent.click(screen.getByTestId('assets-chip-project'));
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

  it('offers the connection once for the whole dialog, not per field', async () => {
    h.githubStatus.mockResolvedValue(false);
    renderDialog();

    const connect = await screen.findByTestId('connect-github');
    await userEvent.click(connect);

    expect(h.connect).toHaveBeenCalledWith('github');
    expect(screen.queryAllByTestId('connect-github')).toHaveLength(1);
  });

  it('reports an existing connection instead of asking for one', async () => {
    renderDialog();

    expect(await screen.findByTestId('github-connected')).toBeInTheDocument();
    expect(screen.queryByTestId('connect-github')).not.toBeInTheDocument();
  });

  it('keeps asking while the status is unknown, rather than reporting "not connected"', async () => {
    // `null` is the bootstrap race, not an answer — reporting it as "no
    // connection" is what the clone dialog learned to avoid.
    h.githubStatus.mockResolvedValueOnce(null).mockResolvedValue(true);
    renderDialog();

    expect(await screen.findByTestId('github-connected')).toBeInTheDocument();
  });
});

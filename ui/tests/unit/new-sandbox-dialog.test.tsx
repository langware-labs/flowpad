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
  // Resolves with a node, like the real `createSandbox`. Tests that care about
  // the failure path override it.
  onCreate: vi.fn(() => Promise.resolve({ id: 'node-created' })),
  onOpen: vi.fn(),
  githubStatus: vi.fn(() => Promise.resolve(true)),
  connect: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('@src/lib/github-oauth-status', () => ({ fetchGithubStatus: h.githubStatus }));
// The real picker is a react-query consumer with its own coverage; here it only
// has to prove the dialog turns a picked repo into the source.
vi.mock('@src/components/git/RepoPicker', () => ({
  RepoPicker: ({ onSelect }: { onSelect: (r: unknown) => void }) => (
    <button
      onClick={() =>
        onSelect({
          name: 'Hello-World',
          git_origin: { provider: 'github', owner: 'octocat', name: 'Hello-World', branch: 'main', rel_path: '.' },
        })
      }
    >
      pick octocat/Hello-World
    </button>
  ),
}));
vi.mock('@sdk/react/hooks', () => ({ useOAuthFlowComplete: () => undefined }));
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, oauthService: { connect: h.connect } };
});

import { NewSandboxDialog } from '@src/pages/hub-home/NewSandboxDialog';

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
    <NewSandboxDialog
      open
      onOpenChange={() => {}}
      defaultName="Sandbox 3"
      currentProject={withRepo}
      projects={[withRepo, desk, repoLess]}
      onCreate={h.onCreate}
      onOpen={h.onOpen}
      steps={[]}
      {...props}
    />,
  );
}

/** The one payload everything here is about. */
function launched() {
  return h.onCreate.mock.calls.at(-1)?.[0];
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

    await userEvent.click(screen.getByTestId('create-sandbox'));

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
    await userEvent.click(screen.getByTestId('create-sandbox'));

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

  it('offers all three ways in, even with no projects to choose between', async () => {
    // A fresh hub account has no projects at all — the moment a missing chip
    // would read as "git is the only way to name a source".
    renderDialog({ currentProject: null, projects: [] });

    for (const way of ['project', 'github', 'url']) {
      expect(screen.getByTestId(`loaded-project-chip-${way}`)).toBeInTheDocument();
    }

    // The panel says why it is empty rather than the chip vanishing.
    await userEvent.click(screen.getByTestId('loaded-project-chip-project'));
    expect(within(screen.getByTestId('loaded-project-projects')).getByText(/No projects/)).toBeInTheDocument();
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
    await userEvent.click(screen.getByTestId('create-sandbox'));

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
    await userEvent.click(screen.getByTestId('create-sandbox'));

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
    await userEvent.click(screen.getByTestId('create-sandbox'));

    expect(launched().sandboxProject.contextProjects).toBeUndefined();
  });

  it('launches a plain desktop when there is no project at all', async () => {
    renderDialog({ currentProject: null, projects: [] });

    await userEvent.click(screen.getByTestId('create-sandbox'));

    expect(launched()).toEqual({ name: 'Sandbox 3' });
  });

  it('offers the connection from the GitHub chip, once for the whole dialog', async () => {
    h.githubStatus.mockResolvedValue(false);
    renderDialog();

    // Unconnected, the chip says what it will do first.
    await userEvent.click(screen.getByTestId('loaded-project-chip-github'));
    const connect = await screen.findByTestId('connect-github');
    await userEvent.click(connect);

    expect(h.connect).toHaveBeenCalledWith('github');
    // Only one panel is open across the dialog, so only one Connect exists.
    expect(screen.queryAllByTestId('connect-github')).toHaveLength(1);
  });

  it('closes after a connect that never came back', async () => {
    // The hang: `connecting` clears only on OAUTH_FLOW_COMPLETE, and that event
    // may never arrive (popup shut, or a message with no matching flow id —
    // oauth-service returns without emitting). Dismissal must not depend on it.
    h.githubStatus.mockResolvedValue(false);
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    await userEvent.click(screen.getByTestId('loaded-project-chip-github'));
    await userEvent.click(await screen.findByTestId('connect-github'));
    expect(h.connect).toHaveBeenCalled(); // still pending — no completion event

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('goes straight to the repo list when GitHub is already connected', async () => {
    renderDialog();

    // Let the status poll settle before opening the panel.
    await screen.findByTestId('loaded-project-chip-github');
    await userEvent.click(screen.getByTestId('loaded-project-chip-github'));

    expect(screen.getByTestId('loaded-project-github')).toBeInTheDocument();
    expect(screen.queryByTestId('connect-github')).not.toBeInTheDocument();
  });

  it('turns a repo picked from GitHub into the loaded project', async () => {
    renderDialog({ currentProject: null, projects: [] });

    await userEvent.click(screen.getByTestId('loaded-project-chip-github'));
    await userEvent.click(await screen.findByRole('button', { name: /pick octocat/ }));
    await userEvent.click(screen.getByTestId('create-sandbox'));

    expect(launched().sandboxProject).toMatchObject({
      name: 'Hello-World',
      gitOrigin: expect.objectContaining({ owner: 'octocat', name: 'Hello-World' }),
    });
  });

  it('keeps asking while the status is unknown, rather than reporting "not connected"', async () => {
    // `null` is the bootstrap race, not an answer — reporting it as "no
    // connection" is what the clone dialog learned to avoid.
    h.githubStatus.mockResolvedValueOnce(null).mockResolvedValue(true);
    renderDialog();

    await userEvent.click(screen.getByTestId('loaded-project-chip-github'));
    // Once the retry lands as `true`, the panel is the picker, not a Connect ask.
    await vi.waitFor(() => expect(screen.queryByTestId('connect-github')).not.toBeInTheDocument());
  });

  it('opens one panel at a time across both fields', async () => {
    renderDialog();

    await userEvent.click(screen.getByTestId('loaded-project-chip-url'));
    expect(screen.getByTestId('loaded-project-url-input')).toBeInTheDocument();

    // The GitHub panel carries the repo table — two of them stacked would bury
    // the footer, so opening one closes the other.
    await userEvent.click(screen.getByTestId('assets-chip-github'));
    expect(screen.queryByTestId('loaded-project-url-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('assets-github')).toBeInTheDocument();
  });
});

/**
 * The three-state machine: idle -> creating -> created.
 *
 * The dialog used to close on click and fire the create at the page behind it,
 * which put progress and any failure somewhere the user was no longer looking.
 * Staying open is what makes the outcome visible — and it is what let the
 * popup-blocker placeholder tab go away, because the open is now its own click.
 */
describe('create / launch state machine', () => {
  it('creates without opening anything, then offers Launch and Done', async () => {
    renderDialog();

    await userEvent.click(screen.getByTestId('create-sandbox'));

    // Creating must NOT open a tab — that is the user's next, separate gesture.
    expect(h.onCreate).toHaveBeenCalledTimes(1);
    expect(h.onOpen).not.toHaveBeenCalled();

    expect(await screen.findByTestId('launch-sandbox')).toBeInTheDocument();
    expect(screen.getByTestId('done-sandbox')).toBeInTheDocument();
    expect(screen.queryByTestId('create-sandbox')).not.toBeInTheDocument();
  });

  it('opens the created box exactly once on Launch', async () => {
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    await userEvent.click(screen.getByTestId('create-sandbox'));
    await userEvent.click(await screen.findByTestId('launch-sandbox'));

    expect(h.onOpen).toHaveBeenCalledTimes(1);
    expect(h.onOpen).toHaveBeenCalledWith({ id: 'node-created' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Done closes without opening the box', async () => {
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    await userEvent.click(screen.getByTestId('create-sandbox'));
    await userEvent.click(await screen.findByTestId('done-sandbox'));

    // The box still exists — it is in the list on the page behind. Done means
    // "I don't want to go in right now", not "undo".
    expect(h.onOpen).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the dialog open and shows the error when the create fails', async () => {
    const onOpenChange = vi.fn();
    h.onCreate.mockRejectedValueOnce(new Error('no e2b capacity'));
    renderDialog({ onOpenChange });

    await userEvent.click(screen.getByTestId('create-sandbox'));

    // THE regression this file exists for: a failure used to land behind a
    // dialog that had already closed, so a failed create looked like nothing
    // happening at all.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(await screen.findByText(/no e2b capacity/)).toBeInTheDocument();
    // Back to idle, with the user's picks intact, so they can just try again.
    expect(screen.getByTestId('create-sandbox')).toBeInTheDocument();
    expect(screen.queryByTestId('launch-sandbox')).not.toBeInTheDocument();
  });

  it('a double-clicked Create provisions one box, not two', async () => {
    let release: (v: { id: string }) => void = () => {};
    h.onCreate.mockImplementationOnce(() => new Promise((res) => (release = res)));
    renderDialog();

    const button = screen.getByTestId('create-sandbox');
    await userEvent.click(button);
    await userEvent.click(button);

    // A second box is not a harmless duplicate: it is a running VM the user did
    // not ask for and has to find and delete.
    expect(h.onCreate).toHaveBeenCalledTimes(1);
    release({ id: 'node-created' });
  });

  it('a create the hook refuses returns to idle without claiming success', async () => {
    // `createSandbox` answers null when one is already in flight. Nothing was
    // provisioned, so this is not an error to report — but it must not show
    // Launch for a box that does not exist either.
    h.onCreate.mockResolvedValueOnce(null as never);
    renderDialog();

    await userEvent.click(screen.getByTestId('create-sandbox'));

    expect(await screen.findByTestId('create-sandbox')).toBeInTheDocument();
    expect(screen.queryByTestId('launch-sandbox')).not.toBeInTheDocument();
    expect(h.onOpen).not.toHaveBeenCalled();
  });
});

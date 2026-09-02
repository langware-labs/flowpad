/**
 * `AgentDeployChecklist` — the pre-deploy setup list above the Deploy button.
 *
 * Covers what the component itself owns: which row is rendered in which status,
 * that exactly ONE row (the first unmet gate) carries a button, that each
 * button reaches the seam the Project "Link to cloud" path already uses, and
 * the tri-state readiness handed to the host.
 *
 * The state MAPPING is pinned separately in `agent-deploy-readiness.test.ts`;
 * the git verdict itself is the backend's and is pinned in
 * `tests/unit/git-share-gate-state.test.ts`. Nothing here shells git or talks
 * to a backend — every probe is mocked at its hook boundary.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hubOnly: false,
  cloudAuthed: true,
  githubConnected: true as boolean | null,
  project: { id: 'p1', name: 'Acme', remote: true, fs_storage_mount_path: '/w/acme', typeId: { toString: () => 'project-p1' } } as
    | Record<string, unknown>
    | null,
  preflight: { loading: false, answered: true, available: true, reason: null as string | null, code: null as string | null, origin: null, refetch: vi.fn() },
  requireCloudLogin: vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string }),
  push: vi.fn(async () => {}),
  pushBusy: false,
  connect: vi.fn(async () => {}),
  launchWizard: vi.fn(async () => ({ status: 'done' })),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  publishButton: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    launchWizard: mocks.launchWizard,
    oauthService: { connect: mocks.connect },
  };
});

vi.mock('@sdk/react/hooks', () => ({
  useProject: () => ({ project: mocks.project }),
  useOAuthFlowComplete: () => undefined,
}));

vi.mock('@src/hooks/use-cloud-authed', () => ({ useCloudAuthed: () => mocks.cloudAuthed }));
vi.mock('@src/hooks/use-cloud-login-gate', () => ({ useCloudLoginGate: () => mocks.requireCloudLogin }));
vi.mock('@src/hooks/use-git-share-preflight', () => ({ useGitSharePreflight: () => mocks.preflight }));
vi.mock('@src/hooks/use-git-push', () => ({
  // The real hook re-checks through its `onAfter`; assert the wiring, not the push.
  useGitPush: (_node: string, _dir: string | null, onAfter?: () => void) => ({
    push: async () => {
      await mocks.push();
      onAfter?.();
    },
    busy: mocks.pushBusy,
  }),
}));
vi.mock('@src/lib/github-oauth-status', () => ({ fetchGithubStatus: async () => mocks.githubConnected }));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => mocks.hubOnly }));
vi.mock('@src/notifications', () => ({
  notify: { error: mocks.notifyError, success: mocks.notifySuccess, info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@src/components/project-home/ProjectPublishButton', () => ({
  ProjectPublishButton: (props: { project: unknown }) => {
    mocks.publishButton(props);
    return <button data-testid="project-publish">Link to cloud</button>;
  },
}));

import { AgentDeployChecklist } from '@src/components/assets/editor/agent-profile/AgentDeployChecklist';

const agent = { typeId: { type: 'agent', id: 'a1', toString: () => 'agent-a1' } } as never;

/** The row's rendered status, as StepList stamps it. */
const status = (id: string) => screen.getByTestId(`agent-deploy-step-${id}`).getAttribute('data-status');
/** Every action button currently on screen, by test id. */
const actionIds = () =>
  screen
    .queryAllByTestId(/^agent-deploy-action-/)
    .map((el) => el.getAttribute('data-testid'));

async function renderChecklist(onReadiness = vi.fn()) {
  const result = render(<AgentDeployChecklist agent={agent} onReadinessChange={onReadiness} />);
  // The GitHub probe is async; let it settle before asserting a row's status.
  await screen.findByTestId('agent-deploy-checklist');
  await vi.waitFor(() => expect(status('github')).not.toBe('loading'));
  return { ...result, onReadiness };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hubOnly = false;
  mocks.cloudAuthed = true;
  mocks.githubConnected = true;
  mocks.project = { id: 'p1', name: 'Acme', remote: true, fs_storage_mount_path: '/w/acme', typeId: { toString: () => 'project-p1' } };
  mocks.preflight = { ...mocks.preflight, loading: false, answered: true, available: true, reason: null, code: null };
  mocks.pushBusy = false;
  mocks.requireCloudLogin.mockResolvedValue({ ok: true });
  mocks.launchWizard.mockResolvedValue({ status: 'done' });
});

afterEach(cleanup);

describe('AgentDeployChecklist', () => {
  it('greys every step out with a Done marker and offers no action when the agent can deploy', async () => {
    const { onReadiness } = await renderChecklist();

    for (const id of ['cloud-login', 'github', 'project', 'repo', 'pushed']) {
      expect(status(id)).toBe('success');
    }
    expect(screen.getAllByText(/— Done/)).toHaveLength(5);
    expect(actionIds()).toEqual([]);
    // The readiness callback is a passive effect, so it lands a tick after the
    // rows above are already on screen.
    await vi.waitFor(() => expect(onReadiness).toHaveBeenLastCalledWith(true));
  });

  it('offers only the first unmet gate, and signs in through the cloud-login gate', async () => {
    mocks.cloudAuthed = false;
    mocks.githubConnected = false;
    const { onReadiness } = await renderChecklist();

    // Two gates are unmet; only the earliest is actionable.
    expect(actionIds()).toEqual(['agent-deploy-action-cloud-login']);
    expect(status('cloud-login')).toBe('idle');
    // The control hangs off the row it belongs to — this is what `Step.action`
    // buys, and the reason StepList renders a checklist it does not drive.
    expect(screen.getByTestId('agent-deploy-step-cloud-login')).toContainElement(
      screen.getByTestId('agent-deploy-action-cloud-login'),
    );
    await vi.waitFor(() => expect(onReadiness).toHaveBeenLastCalledWith(false));

    await userEvent.click(screen.getByTestId('agent-deploy-action-cloud-login'));

    expect(mocks.requireCloudLogin).toHaveBeenCalledTimes(1);
  });

  it('reports a cancelled sign-in instead of failing silently', async () => {
    mocks.cloudAuthed = false;
    mocks.requireCloudLogin.mockResolvedValue({ ok: false, error: 'Login was canceled.' });
    await renderChecklist();

    await userEvent.click(screen.getByTestId('agent-deploy-action-cloud-login'));

    await vi.waitFor(() => expect(mocks.notifyError).toHaveBeenCalled());
    // Deploy's own toasts are suppressed outside Dev mode; a silent no-op here
    // would read as a broken button for the same reason.
    expect(mocks.notifyError.mock.calls[0][0]).toMatchObject({ forceToast: true });
  });

  it('connects GitHub from the github row', async () => {
    mocks.githubConnected = false;
    await renderChecklist();

    expect(actionIds()).toEqual(['agent-deploy-action-github']);
    await userEvent.click(screen.getByTestId('agent-deploy-action-github'));

    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledWith('github'));
  });

  it('hands the project row to the existing ProjectPublishButton', async () => {
    mocks.project = { ...(mocks.project as Record<string, unknown>), remote: false };
    await renderChecklist();

    expect(status('project')).toBe('idle');
    expect(screen.getByTestId('project-publish')).toBeInTheDocument();
    expect(mocks.publishButton).toHaveBeenCalledWith({ project: mocks.project });
  });

  it('offers repo setup, and leaves the push question unanswered while there is no repo', async () => {
    mocks.preflight = { ...mocks.preflight, available: false, code: 'not-in-repo', reason: 'The asset is not inside a Git repository.' };
    await renderChecklist();

    expect(actionIds()).toEqual(['agent-deploy-action-repo']);
    // `idle`, not `error`: a directory with no repo says nothing about its commits.
    expect(status('pushed')).toBe('idle');

    await userEvent.click(screen.getByTestId('agent-deploy-action-repo'));

    await vi.waitFor(() => expect(mocks.launchWizard).toHaveBeenCalled());
    expect(mocks.launchWizard.mock.calls[0][0]).toBe('git-context-folder');
    // Adopt the project folder IN PLACE — a clone elsewhere publishes a different tree.
    expect(mocks.launchWizard.mock.calls[0][1]).toMatchObject({ payload: { mode: 'adopt', path: '/w/acme' } });
    // One re-check, on completion. Event-driven, never polled.
    expect(mocks.preflight.refetch).toHaveBeenCalledTimes(1);
  });

  it('pushes from the pushed row and re-checks when the push settles', async () => {
    mocks.preflight = { ...mocks.preflight, available: false, code: 'unpushed', reason: 'The branch has unpushed commits.' };
    await renderChecklist();

    // A repo you can commit in exists — only the travelling is outstanding.
    expect(status('repo')).toBe('success');
    expect(actionIds()).toEqual(['agent-deploy-action-pushed']);

    await userEvent.click(screen.getByTestId('agent-deploy-action-pushed'));

    await vi.waitFor(() => expect(mocks.push).toHaveBeenCalledTimes(1));
    expect(mocks.preflight.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the backend reason and no button for a state neither remediation fixes', async () => {
    mocks.preflight = { ...mocks.preflight, available: false, code: 'detached-head', reason: 'The repository is in a detached-HEAD state — check out a branch.' };
    const { onReadiness } = await renderChecklist();

    expect(status('repo')).toBe('error');
    expect(screen.getByTestId('agent-deploy-step-repo')).toHaveTextContent('detached-HEAD');
    expect(actionIds()).toEqual([]);
    await vi.waitFor(() => expect(onReadiness).toHaveBeenLastCalledWith(false));
  });

  it('stays undecided while a probe has not answered, so the host keeps Deploy enabled', async () => {
    mocks.githubConnected = null;
    const onReadiness = vi.fn();
    render(<AgentDeployChecklist agent={agent} onReadinessChange={onReadiness} />);
    await screen.findByTestId('agent-deploy-checklist');

    await vi.waitFor(() => expect(onReadiness).toHaveBeenCalled());
    expect(onReadiness.mock.calls.every(([ready]) => ready !== false)).toBe(true);
    expect(status('github')).toBe('loading');
  });

  it('renders nothing on the hub, which has no local checkout to check', () => {
    mocks.hubOnly = true;
    render(<AgentDeployChecklist agent={agent} />);

    expect(screen.queryByTestId('agent-deploy-checklist')).not.toBeInTheDocument();
  });
});

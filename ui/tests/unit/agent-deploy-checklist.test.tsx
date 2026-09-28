/**
 * `AgentDeployChecklist` — the pre-deploy setup list above the Deploy button.
 *
 * Covers what the component itself owns: which row is rendered in which status,
 * that exactly ONE row (the first unmet gate) carries a button, that each
 * button reaches the right seam, and the tri-state readiness handed to the host.
 *
 * A deploy publishes the agent into its project's hub-hosted repository, so the
 * list is: signed in to Flowpad cloud → project linked to cloud → (advice)
 * published version up to date. No git or GitHub row exists any more.
 *
 * The state MAPPING is pinned separately in `agent-deploy-readiness.test.ts`.
 * Every probe is mocked at its hook boundary.
 */
import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hubOnly: false,
  cloudAuthed: true,
  project: {
    id: 'p1',
    name: 'Acme',
    remote: true,
    fs_storage_mount_path: '/w/acme',
    typeId: { toString: () => 'project-p1' },
  } as Record<string, unknown> | null,
  requireCloudLogin: vi.fn(() => Promise.resolve({ ok: true } as { ok: boolean; error?: string })),
  versionState: vi.fn(() =>
    Promise.resolve({ published: true, published_commit: 'abc1234', has_repo: true, pending_changes: 0 }),
  ),
  publish: vi.fn(() => Promise.resolve({ agent_id: 'a1', published: true, already_on_hub: false })),
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  publishButton: vi.fn(),
}));

vi.mock('@sdk/react/hooks', () => ({
  useProject: () => ({ project: mocks.project }),
}));

vi.mock('@src/hooks/use-cloud-authed', () => ({ useCloudAuthed: () => mocks.cloudAuthed }));
vi.mock('@src/hooks/use-cloud-login-gate', () => ({ useCloudLoginGate: () => mocks.requireCloudLogin }));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => mocks.hubOnly }));
vi.mock('@src/notifications', () => ({
  notify: { error: mocks.notifyError, success: mocks.notifySuccess, info: vi.fn(), warning: vi.fn() },
}));
vi.mock('@src/components/project-home/ProjectCloudLinkButton', () => ({
  ProjectCloudLinkButton: (props: { project: unknown }) => {
    mocks.publishButton(props);
    return <button data-testid="project-publish">Link to cloud</button>;
  },
}));

import { AgentDeployChecklist } from '@src/components/assets/editor/agent-profile/AgentDeployChecklist';

const agent = {
  typeId: { type: 'agent', id: 'a1', toString: () => 'agent-a1' },
  updated_date: undefined,
  versionState: mocks.versionState,
  publish: mocks.publish,
} as never;

/** The row's rendered status, as StepList stamps it. */
const status = (id: string) => screen.getByTestId(`agent-deploy-step-${id}`).getAttribute('data-status');
/** Every action button currently on screen, by test id. */
const actionIds = () => screen.queryAllByTestId(/^agent-deploy-action-/).map((el) => el.getAttribute('data-testid'));

async function renderChecklist(onReadiness = vi.fn()) {
  const result = render(<AgentDeployChecklist agent={agent} onReadinessChange={onReadiness} />);
  // The version read is async; let it settle before asserting a row's status.
  await screen.findByTestId('agent-deploy-checklist');
  await vi.waitFor(() => expect(status('version')).not.toBe('loading'));
  return { ...result, onReadiness };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hubOnly = false;
  mocks.cloudAuthed = true;
  mocks.project = {
    id: 'p1',
    name: 'Acme',
    remote: true,
    fs_storage_mount_path: '/w/acme',
    typeId: { toString: () => 'project-p1' },
  };
  mocks.requireCloudLogin.mockResolvedValue({ ok: true });
  mocks.versionState.mockResolvedValue({
    published: true,
    published_commit: 'abc1234',
    has_repo: true,
    pending_changes: 0,
  });
});

afterEach(cleanup);

describe('AgentDeployChecklist', () => {
  it('lists only cloud login, project link and the published version — no git or GitHub rows', async () => {
    await renderChecklist();

    for (const id of ['github', 'repo', 'pushed']) {
      expect(screen.queryByTestId(`agent-deploy-step-${id}`)).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/GitHub/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Git repository/)).not.toBeInTheDocument();
  });

  it('greys every step out with a Done marker and offers no action when the agent can deploy', async () => {
    const { onReadiness } = await renderChecklist();

    for (const id of ['cloud-login', 'project', 'version']) {
      expect(status(id)).toBe('success');
    }
    expect(screen.getAllByText(/— Done/)).toHaveLength(3);
    expect(actionIds()).toEqual([]);
    await vi.waitFor(() => expect(onReadiness).toHaveBeenLastCalledWith(true));
  });

  it('offers only the first unmet gate, and signs in through the cloud-login gate', async () => {
    mocks.cloudAuthed = false;
    mocks.project = { ...(mocks.project as Record<string, unknown>), remote: false };
    const { onReadiness } = await renderChecklist();

    expect(actionIds()).toEqual(['agent-deploy-action-cloud-login']);
    expect(screen.queryByTestId('project-publish')).not.toBeInTheDocument();
    expect(status('cloud-login')).toBe('idle');
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
    expect(mocks.notifyError.mock.calls[0][0]).toMatchObject({ forceToast: true });
  });

  it('hands the project row to the existing ProjectCloudLinkButton', async () => {
    mocks.project = { ...(mocks.project as Record<string, unknown>), remote: false };
    const { onReadiness } = await renderChecklist();

    expect(status('project')).toBe('idle');
    expect(screen.getByTestId('project-publish')).toBeInTheDocument();
    expect(mocks.publishButton).toHaveBeenCalledWith({ project: mocks.project });
    await vi.waitFor(() => expect(onReadiness).toHaveBeenLastCalledWith(false));
  });

  it('offers Publish when the published version lacks local edits, without disabling Deploy', async () => {
    mocks.versionState.mockResolvedValue({
      published: true,
      published_commit: 'abc1234',
      has_repo: true,
      pending_changes: 2,
    });
    const { onReadiness } = await renderChecklist();

    expect(status('version')).toBe('idle');
    expect(screen.getByTestId('agent-deploy-step-version')).toHaveTextContent('2 changes not published');
    expect(actionIds()).toEqual(['agent-deploy-action-version']);
    await vi.waitFor(() => expect(onReadiness).toHaveBeenLastCalledWith(true));

    mocks.versionState.mockResolvedValue({
      published: true,
      published_commit: 'def5678',
      has_repo: true,
      pending_changes: 0,
    });
    await userEvent.click(screen.getByTestId('agent-deploy-action-version'));

    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledWith({ force: true }));
    // Re-read once the publish settles: the row turns done.
    await vi.waitFor(() => expect(status('version')).toBe('success'));
  });

  it('treats a never-published agent as up to date — the deploy publishes it', async () => {
    mocks.versionState.mockResolvedValue({
      published: false,
      published_commit: '',
      has_repo: false,
      pending_changes: 0,
    });
    await renderChecklist();

    expect(status('version')).toBe('success');
    expect(screen.getByTestId('agent-deploy-step-version')).toHaveTextContent('Published when you deploy');
  });

  it('stays undecided while the project has not loaded, so the host keeps Deploy enabled', async () => {
    mocks.project = null;
    const onReadiness = vi.fn();
    render(<AgentDeployChecklist agent={agent} onReadinessChange={onReadiness} />);
    await screen.findByTestId('agent-deploy-checklist');

    await vi.waitFor(() => expect(onReadiness).toHaveBeenCalled());
    expect(onReadiness.mock.calls.every(([ready]) => ready !== false)).toBe(true);
    expect(status('project')).toBe('loading');
  });

  it('renders nothing on the hub, which has no local project to check', () => {
    mocks.hubOnly = true;
    render(<AgentDeployChecklist agent={agent} />);

    expect(screen.queryByTestId('agent-deploy-checklist')).not.toBeInTheDocument();
  });
});

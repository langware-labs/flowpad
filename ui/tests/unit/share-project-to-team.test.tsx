/**
 * Handing one project to a whole team, from the team row on People & teams.
 *
 * Locked here, in order of what would hurt most if it regressed:
 *
 *  - **A private repository is warned about, and does not block.** The share
 *    itself works perfectly on a private repo — the recipients get the project
 *    and its language — so refusing it would be wrong. What they cannot do is
 *    OPEN it without their own GitHub access, and Flowpad cannot grant that, so
 *    the admin is told before the invitations go out rather than after.
 *  - **The team travels as a team, in ONE share action.** The dialog posts the
 *    TEAM to the project's `share` action (`{recipients: [], teams: [team-<id>]}`);
 *    the backend expands it through the team's member list and sends every
 *    person a message-flagged invite. The dialog's own roster walk only counts
 *    people for the preview. The returned `share_result` is shown per person.
 *  - **An unpublished project gets the publish popup INSTEAD of this dialog.**
 *    That a published one invites without the publish gate is the share
 *    action's contract (tests/unit/test_project_share_invite_message.py).
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  recipients: vi.fn(),
  access: {
    loading: false,
    public: null as boolean | null,
    repo: null as string | null,
    code: null as string | null,
    answered: true,
  },
  project: null as unknown,
  hubOnly: false,
}));

vi.mock('@src/hooks/use-git-anonymous-access', () => ({ useGitAnonymousAccess: () => h.access }));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: h.project }) }));
vi.mock('@src/components/organization/budgets/team-recipients', () => ({
  collectTeamRecipients: (...args: unknown[]) => h.recipients(...args),
}));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => h.hubOnly }));
vi.mock('@src/hooks/use-claude-projects', () => ({ getProjectDisplayName: (p: { name: string }) => p.name }));
vi.mock('@sdk/react/hooks', () => ({ useOAuthFlowComplete: () => undefined }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  oauthService: { connect: vi.fn() },
}));
vi.mock('@src/notifications', () => ({
  notify: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
// The publish control is its own component with its own tests; here it only has
// to be present inside the popup.
vi.mock('@src/components/project-home/ProjectCloudLinkButton', () => ({
  ProjectCloudLinkButton: () => <button type="button">link-to-cloud</button>,
}));
// The picker is its own component with its own project list; here it only has to
// hand back a choice so the dialog under test can open.
vi.mock('@src/components/assets/ProjectPickerModal', () => ({
  ProjectPickerModal: ({
    open,
    onConfirm,
  }: {
    open: boolean;
    onConfirm: (ids: string[], items: { id: string; name: string }[]) => void;
  }) =>
    open ? (
      <button type="button" onClick={() => onConfirm([PROJECT_ID], [{ id: PROJECT_ID, name: 'Atlas' }])}>
        pick-atlas
      </button>
    ) : null,
}));

import { dataManager, Project, type ShareResult } from '@sdk';
import { ShareProjectButton } from '@src/components/organization/budgets/ShareProjectPanel';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const TEAM_ID = UUID(1);
const PROJECT_ID = UUID(2);
// One instance per id: the SDK registers every entity it constructs.
const PUBLISHED = new Project({ type: Project.type, id: PROJECT_ID, name: 'Atlas', remote: true } as Partial<Project>);
const UNPUBLISHED = new Project({ type: Project.type, id: UUID(3), name: 'Atlas', remote: false } as Partial<Project>);

const TWO_INVITED: ShareResult = {
  invited: [
    { user_id: 'u-ada', email: 'ada@example.com', name: 'Ada', conversation_id: null },
    { user_id: 'u-grace', email: null, name: 'Grace', conversation_id: null },
  ],
  skipped: [],
  failed: [],
  skipped_teams: [],
};

/** The project's `share` action answering `shareResult` (or refusing with `error`). */
function shareAction(shareResult: ShareResult | null, error?: Error) {
  return vi
    .spyOn(dataManager, 'callAction')
    .mockImplementation(() =>
      error ? Promise.reject(error) : Promise.resolve({ type: 'project', id: PROJECT_ID, share_result: shareResult }),
    );
}

let call: ReturnType<typeof shareAction>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  h.access = { loading: false, public: true, repo: 'acme/atlas', code: null, answered: true };
  h.project = PUBLISHED;
  h.hubOnly = false;
  call = shareAction(TWO_INVITED);
  h.recipients.mockResolvedValue({ people: ['u-ada', 'u-grace'], unreachable: 0 });
});

afterEach(() => cleanup());

/** Press "Share project", then pick the one project the stubbed picker offers. */
async function openDialog() {
  const user = userEvent.setup();
  render(<ShareProjectButton teamId={TEAM_ID} teamName="Physics" />);
  await user.click(screen.getByTestId(`team-share-project-${TEAM_ID}`));
  await user.click(await screen.findByText('pick-atlas'));
  await screen.findByTestId('team-share-project-dialog');
  return user;
}

describe('sharing a project with a team', () => {
  it('posts the team to the project’s share action, once, with only the share keys', async () => {
    const user = await openDialog();

    expect(await screen.findByTestId('team-share-project-recipients')).toHaveTextContent('2 people');
    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('team-share-project-confirm'));

    expect(await screen.findByTestId('share-invite-invited')).toHaveTextContent('Ada');
    expect(call).toHaveBeenCalledTimes(1);
    const info = call.mock.calls[0][0];
    expect([info.name, info.method, info.targetEntity?.toString()]).toEqual(['share', 'POST', `project-${PROJECT_ID}`]);
    expect(info.bodyParameters).toEqual({ recipients: [], teams: [`team-${TEAM_ID}`] });
  });

  it('shows who was invited and who could not be', async () => {
    call = shareAction({
      invited: [{ user_id: 'u-ada', email: 'ada@example.com', name: 'Ada', conversation_id: null }],
      skipped: [{ user_id: 'u-grace', email: null, name: 'Grace', reason: 'already_member' }],
      failed: [{ user_id: 'u-mia', email: null, name: 'Mia', status: 500, message: 'Hub error' }],
      skipped_teams: [{ team: `team-${UUID(9)}`, name: 'Juniors', reason: 'not_listable' }],
    });
    const user = await openDialog();
    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('team-share-project-confirm'));

    expect(await screen.findByTestId('share-invite-invited')).toHaveTextContent('Ada');
    expect(screen.getByTestId('share-invite-skipped')).toHaveTextContent('Grace');
    expect(screen.getByTestId('share-invite-failed')).toHaveTextContent('Hub error');
    expect(screen.getByTestId('share-invite-skipped-teams')).toHaveTextContent('Juniors');
  });

  it('warns about a private repository without blocking the share', async () => {
    h.access = { ...h.access, public: false, repo: 'acme/atlas' };
    const user = await openDialog();

    const warning = await screen.findByTestId('team-share-project-private-repo');
    expect(warning).toHaveTextContent('acme/atlas');
    expect(warning.textContent).toMatch(/private/i);
    // (b) is a warning, not a refusal — the project still shares.
    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('team-share-project-confirm'));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  });

  it('says nothing about the repository when anyone can clone it', async () => {
    await openDialog();

    await screen.findByTestId('team-share-project-recipients');
    expect(screen.queryByTestId('team-share-project-private-repo')).toBeNull();
  });

  it('offers GitHub when that is the only thing missing', async () => {
    // The share action runs the publish rules; this is the one refusal with a one-click fix.
    call = shareAction(
      null,
      Object.assign(new Error('refused'), { response: { data: { data: { code: 'github_not_connected' } } } }),
    );
    const user = await openDialog();

    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('team-share-project-confirm'));

    expect(await screen.findByTestId('team-share-project-connect-github')).toBeInTheDocument();
  });

  it('is not offered on the hub, which has neither the projects nor the checkouts', () => {
    h.hubOnly = true;
    render(<ShareProjectButton teamId={TEAM_ID} teamName="Physics" />);

    expect(screen.queryByTestId(`team-share-project-${TEAM_ID}`)).toBeNull();
  });

  it('shows the publish popup instead of the dialog for a project that is not in the cloud', async () => {
    h.project = UNPUBLISHED;
    const user = userEvent.setup();
    render(<ShareProjectButton teamId={TEAM_ID} teamName="Physics" />);
    await user.click(screen.getByTestId(`team-share-project-${TEAM_ID}`));
    await user.click(await screen.findByText('pick-atlas'));

    expect(await screen.findByTestId('publish-project-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('team-share-project-dialog')).not.toBeInTheDocument();
    expect(call).not.toHaveBeenCalled();
  });
});

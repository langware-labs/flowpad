/**
 * Handing one project to a whole team, from the team row on People & teams.
 *
 * Locked here, in order of what would hurt most if it regressed:
 *
 *  - **The team is granted as ONE principal.** One share call names the team
 *    itself — no roster walk, no per-person invite — and reports per team:
 *    granted, already granted, granted without its invite message, or refused.
 *  - **Linking needs no git.** The project's published assets live in its
 *    hub-hosted repository, so a folder with no repo, a dirty tree or a private
 *    GitHub remote shares just the same — no preflight refusal, no private-repo
 *    warning, no Connect GitHub retry.
 *  - **Inviting is not publishing.** An unpublished project gets the publish
 *    popup INSTEAD of this dialog.
 *  - **A backend refusal is shown in the backend's own words.**
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  invite: vi.fn(),
  notifyError: vi.fn(),
  project: { remote: true } as Record<string, unknown>,
  hubOnly: false,
}));

// A git check that would refuse, were it still consulted: linking must not ask it.
const preflight = vi.hoisted(() => vi.fn(() => ({ available: false, answered: true, code: 'dirty', reason: 'dirty' })));
vi.mock('@src/hooks/use-git-share-preflight', () => ({ useGitSharePreflight: preflight }));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: h.project }) }));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => h.hubOnly }));
vi.mock('@src/hooks/use-claude-projects', () => ({ getProjectDisplayName: (p: { name: string }) => p.name }));
vi.mock('@src/notifications', () => ({
  notify: { success: vi.fn(), error: h.notifyError, info: vi.fn(), warning: vi.fn() },
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

import { ShareProjectButton } from '@src/components/organization/budgets/ShareProjectPanel';
import { notify } from '@src/notifications';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const TEAM_ID = UUID(1);
const PROJECT_ID = UUID(2);

beforeEach(() => {
  vi.clearAllMocks();
  h.project = { remote: true, invite: h.invite };
  h.hubOnly = false;
  h.invite.mockResolvedValue(granted('conv-1'));
});

function granted(conversationId: string | null) {
  return {
    invited: [],
    skipped: [],
    failed: [],
    granted_teams: [{ team: `team-${TEAM_ID}`, name: null, conversation_id: conversationId }],
    skipped_teams: [],
    failed_teams: [],
  };
}

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
  it('grants the team itself in one share call, with no roster read', async () => {
    const user = await openDialog();

    expect(screen.queryByText(/Reading this team/)).toBeNull();
    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('team-share-project-confirm'));

    await waitFor(() => expect(h.invite).toHaveBeenCalledTimes(1));
    const [users, opts] = h.invite.mock.calls[0];
    expect(users).toEqual([]);
    expect(opts.teams.map(String)).toEqual([`team-${TEAM_ID}`]);
    await waitFor(() => expect(notify.success).toHaveBeenCalledTimes(1));
  });

  it('warns when the team was granted but its invite message was not sent', async () => {
    h.invite.mockResolvedValue(granted(null));
    const user = await openDialog();

    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('team-share-project-confirm'));

    await waitFor(() => expect(notify.warning).toHaveBeenCalledTimes(1));
    expect(notify.success).not.toHaveBeenCalled();
  });

  it('says the team already has the project when it was granted before', async () => {
    h.invite.mockResolvedValue({
      ...granted(null),
      granted_teams: [],
      skipped_teams: [{ team: `team-${TEAM_ID}`, name: 'Physics', reason: 'already_granted' }],
    });
    const user = await openDialog();

    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('team-share-project-confirm'));

    await waitFor(() => expect(notify.info).toHaveBeenCalledTimes(1));
    expect(vi.mocked(notify.info).mock.calls[0][0].message).toMatch(/already has access/);
  });

  it('shows the hub message when the team grant is refused', async () => {
    h.invite.mockResolvedValue({
      ...granted(null),
      granted_teams: [],
      failed_teams: [{ team: `team-${TEAM_ID}`, name: null, status: 403, message: 'not allowed here' }],
    });
    const user = await openDialog();

    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('team-share-project-confirm'));

    await waitFor(() => expect(notify.error).toHaveBeenCalledTimes(1));
    expect(vi.mocked(notify.error).mock.calls[0][0].message).toBe('not allowed here');
  });

  it('shares without consulting any git state — no preflight, no private-repo warning', async () => {
    const user = await openDialog();

    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    expect(preflight).not.toHaveBeenCalled();
    expect(screen.queryByTestId('team-share-project-blocked')).toBeNull();
    expect(screen.queryByTestId('team-share-project-private-repo')).toBeNull();

    await user.click(screen.getByTestId('team-share-project-confirm'));
    await waitFor(() => expect(h.invite).toHaveBeenCalledTimes(1));
  });

  it('shows a refusal in the backend’s own words, with no Connect GitHub retry', async () => {
    h.invite.mockRejectedValue(new Error('Cloud login required before linking a Project to the cloud'));
    const user = await openDialog();

    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('team-share-project-confirm'));

    await waitFor(() =>
      expect(h.notifyError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Cloud login required before linking a Project to the cloud' }),
      ),
    );
    expect(screen.queryByTestId('team-share-project-connect-github')).toBeNull();
  });

  it('is not offered on the hub, which has none of the local projects', () => {
    h.hubOnly = true;
    render(<ShareProjectButton teamId={TEAM_ID} teamName="Physics" />);

    expect(screen.queryByTestId(`team-share-project-${TEAM_ID}`)).toBeNull();
  });

  it('shows the publish popup instead of the dialog for a project that is not in the cloud', async () => {
    h.project = { remote: false, invite: h.invite };
    const user = userEvent.setup();
    render(<ShareProjectButton teamId={TEAM_ID} teamName="Physics" />);
    await user.click(screen.getByTestId(`team-share-project-${TEAM_ID}`));
    await user.click(await screen.findByText('pick-atlas'));

    expect(await screen.findByTestId('publish-project-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('team-share-project-dialog')).not.toBeInTheDocument();
    expect(h.invite).not.toHaveBeenCalled();
  });
});

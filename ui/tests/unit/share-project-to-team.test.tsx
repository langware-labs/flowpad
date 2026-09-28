/**
 * Handing one project to a whole team, from the team row on People & teams.
 *
 * Locked here, in order of what would hurt most if it regressed:
 *
 *  - **One share call carries the whole team**, addressed by email, which is the
 *    only thing a `MembershipRequest` accepts.
 *  - **Linking needs no git.** The project's published assets live in its
 *    hub-hosted repository, so a folder with no repo, a dirty tree or a private
 *    GitHub remote shares just the same — no preflight refusal, no private-repo
 *    warning, no Connect GitHub retry.
 *  - **A backend refusal is shown in the backend's own words.**
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  share: vi.fn(),
  recipients: vi.fn(),
  notifyError: vi.fn(),
  project: { remote: true } as Record<string, unknown>,
  hubOnly: false,
}));

// A git check that would refuse, were it still consulted: linking must not ask it.
const preflight = vi.hoisted(() => vi.fn(() => ({ available: false, answered: true, code: 'dirty', reason: 'dirty' })));
vi.mock('@src/hooks/use-git-share-preflight', () => ({ useGitSharePreflight: preflight }));
vi.mock('@src/hooks/entity-hooks', () => ({ useEntity: () => ({ data: h.project }) }));
vi.mock('@src/components/organization/budgets/team-recipients', () => ({
  collectTeamRecipients: (...args: unknown[]) => h.recipients(...args),
}));
vi.mock('@src/navigation/hub-runtime', () => ({ isHubOnly: () => h.hubOnly }));
vi.mock('@src/hooks/use-claude-projects', () => ({ getProjectDisplayName: (p: { name: string }) => p.name }));
vi.mock('@src/notifications', () => ({
  notify: { success: vi.fn(), error: h.notifyError, info: vi.fn() },
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

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const TEAM_ID = UUID(1);
const PROJECT_ID = UUID(2);

beforeEach(() => {
  vi.clearAllMocks();
  h.project = { remote: true, share: h.share };
  h.hubOnly = false;
  h.share.mockResolvedValue(undefined);
  h.recipients.mockResolvedValue({ emails: ['ada@example.com', 'grace@example.com'], unreachable: 0 });
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
  it('invites everyone the roster walk found, in one call', async () => {
    const user = await openDialog();

    expect(await screen.findByTestId('team-share-project-recipients')).toHaveTextContent('2 people');
    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('team-share-project-confirm'));

    await waitFor(() => expect(h.share).toHaveBeenCalledTimes(1));
    expect(h.share).toHaveBeenCalledWith(['ada@example.com', 'grace@example.com']);
  });

  it('shares without consulting any git state — no preflight, no private-repo warning', async () => {
    const user = await openDialog();

    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    expect(preflight).not.toHaveBeenCalled();
    expect(screen.queryByTestId('team-share-project-blocked')).toBeNull();
    expect(screen.queryByTestId('team-share-project-private-repo')).toBeNull();

    await user.click(screen.getByTestId('team-share-project-confirm'));
    await waitFor(() => expect(h.share).toHaveBeenCalledTimes(1));
  });

  it('shows a refusal in the backend’s own words, with no Connect GitHub retry', async () => {
    h.share.mockRejectedValue(new Error('Cloud login required before linking a Project to the cloud'));
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

  it('says a project that is not in the cloud will be linked by sharing it', async () => {
    h.project = { remote: false, share: h.share };
    await openDialog();

    expect(await screen.findByTestId('team-share-project-will-link')).toBeInTheDocument();
  });
});

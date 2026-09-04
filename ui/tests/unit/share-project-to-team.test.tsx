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
 *  - **One share call carries the whole team**, addressed by email, which is the
 *    only thing a `MembershipRequest` accepts.
 *  - **A project that cannot be linked to the cloud cannot be shared**, and says
 *    the backend's own reason — the publish rules are the server's, and this
 *    dialog only asks them early.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  share: vi.fn(),
  recipients: vi.fn(),
  preflight: {
    loading: false,
    available: true,
    reason: null as string | null,
    code: null as string | null,
    origin: null,
    answered: true,
    refetch: vi.fn(),
  },
  access: {
    loading: false,
    public: null as boolean | null,
    repo: null as string | null,
    code: null as string | null,
    answered: true,
  },
  project: { remote: true } as Record<string, unknown>,
  hubOnly: false,
}));

vi.mock('@src/hooks/use-git-share-preflight', () => ({ useGitSharePreflight: () => h.preflight }));
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
  h.preflight = { ...h.preflight, available: true, reason: null, code: null, answered: true };
  h.access = { loading: false, public: true, repo: 'acme/atlas', code: null, answered: true };
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

  it('warns about a private repository without blocking the share', async () => {
    h.access = { ...h.access, public: false, repo: 'acme/atlas' };
    const user = await openDialog();

    const warning = await screen.findByTestId('team-share-project-private-repo');
    expect(warning).toHaveTextContent('acme/atlas');
    expect(warning.textContent).toMatch(/private/i);
    // (b) is a warning, not a refusal — the project still shares.
    await waitFor(() => expect(screen.getByTestId('team-share-project-confirm')).toBeEnabled());
    await user.click(screen.getByTestId('team-share-project-confirm'));
    await waitFor(() => expect(h.share).toHaveBeenCalledTimes(1));
  });

  it('says nothing about the repository when anyone can clone it', async () => {
    await openDialog();

    await screen.findByTestId('team-share-project-recipients');
    expect(screen.queryByTestId('team-share-project-private-repo')).toBeNull();
  });

  it('refuses, with the backend’s reason, when the project cannot be linked to the cloud', async () => {
    h.preflight = {
      ...h.preflight,
      available: false,
      reason: 'The repository has uncommitted changes — commit them so they travel.',
      code: 'dirty',
    };
    await openDialog();

    expect(await screen.findByTestId('team-share-project-blocked')).toHaveTextContent('uncommitted changes');
    expect(screen.getByTestId('team-share-project-confirm')).toBeDisabled();
    expect(h.share).not.toHaveBeenCalled();
  });

  it('offers GitHub when that is the only thing missing', async () => {
    h.share.mockRejectedValue({ response: { data: { data: { code: 'github_not_connected' } } } });
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

  it('says a project that is not in the cloud will be linked by sharing it', async () => {
    h.project = { remote: false, share: h.share };
    await openDialog();

    expect(await screen.findByTestId('team-share-project-will-link')).toBeInTheDocument();
  });
});

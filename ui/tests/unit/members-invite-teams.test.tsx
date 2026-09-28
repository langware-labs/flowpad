/**
 * Teams in the project MEMBERS popover's add-member form.
 *
 * On a Project, whoever can open the add-member form (an editor here, not only
 * an admin) is offered the hub teams this desk knows; a picked team is ONE chip,
 * never expanded, and Apply sends people and teams through ONE `share` action
 * (`Project.invite`), where the hub grants each team as one principal. A granted
 * team is one roster row with its icon and a locked role; each partial outcome is
 * reported. A conversation never offers teams.
 *
 * React test in the UNIT tier: the react tier needs a live backend. The real
 * `useMembers` runs; only the entity/team queries and `dataManager.callAction`
 * are stubbed.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionInfo, QueryRequest, ShareResult } from '@sdk';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const SANDBOX = { id: UUID(1), name: 'sandbox-team', remote: true };
const PROJECT_ID = UUID(2);
const CONVERSATION_ID = UUID(3);

const h = vi.hoisted(() => ({ entity: null as unknown }));

vi.mock('@src/hooks/entity-hooks', () => ({
  useEntity: () => ({ data: h.entity }),
  // Mirrors the real hook: a disabled query reads nothing.
  useEntitiesQuery: (request: QueryRequest, opts?: { enabled?: boolean }) => ({
    data: request.type === 'team' && opts?.enabled !== false ? [SANDBOX] : [],
    refetch: () => undefined,
  }),
}));
vi.mock('@src/hooks/use-membership-availability', () => ({
  useMembershipAvailability: () => ({ available: true, reason: 'available' }),
}));
vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => ({ cloudUser: { id: 'me-id', email: 'me@example.com' }, currentUser: null }),
  useContext: () => ({ cloudLoginAvailable: true, isDesktop: true }),
  useProject: () => ({ project: null }),
}));
vi.mock('@src/hooks/use-login-required', () => ({
  useLoginRequired: () => ({ checkLoginAndProceed: () => true, showLoginDialog: false, closeLoginDialog: vi.fn() }),
}));
vi.mock('@src/components/login-required-dialog', () => ({ ActionType: { MEMBERS: 'members' }, default: () => null }));
vi.mock('@src/components/conversation/useLocalUser', () => ({
  useLocalUser: () => ({ localUser: { id: 'me-id', email: 'me@example.com' } }),
}));
vi.mock('@src/components/conversation/ContactPermissionsDialog', () => ({ ContactPermissionsDialog: () => null }));
vi.mock('@src/components/contact-picker/use-contacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/contact-picker/use-contacts')>()),
  useContacts: () => ({ contacts: [{ id: 'u-noa', email: 'noa@example.com', name: 'Noa' }], refetch: vi.fn() }),
}));
vi.mock('@src/components/contact-picker/use-contacts-groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/contact-picker/use-contacts-groups')>()),
  useContactsGroups: () => ({ groups: [], refetch: vi.fn() }),
}));
vi.mock('@src/components/contact-picker/AddressBookButton', () => ({ AddressBookButton: () => null }));

import { Conversation, dataManager, Project, TypeId } from '@sdk';
import { MembersAvatarStack } from '@src/components/conversation/MembersAvatarStack';

// One instance per id: the SDK registers every entity it constructs.
const PROJECT = new Project({ type: Project.type, id: PROJECT_ID, name: 'Atlas', remote: true } as Partial<Project>);
const CONVERSATION = new Conversation({
  type: Conversation.type,
  id: CONVERSATION_ID,
  remote: true,
} as Partial<Conversation>);

/** The roster the `members` action answers — I am an editor, not an admin. */
const ME = { user_id: 'me-id', email: 'me@example.com', name: 'Me', role: 'editor' };
const ROSTER = [ME];
/** A roster after sandbox-team was granted: one team row, and its member Dana
 *  listed as an ordinary user row (the hub flattens inherited people). */
const ROSTER_WITH_TEAM = [
  ME,
  { type: 'team', id: SANDBOX.id, user_id: null, name: 'sandbox-team', role: 'member', status: 'approved' },
  { user_id: 'dana-id', email: null, name: 'Dana', role: 'member' },
];

const EMPTY_RESULT: ShareResult = {
  invited: [],
  skipped: [],
  failed: [],
  granted_teams: [],
  skipped_teams: [],
  failed_teams: [],
};

let shareResult: ShareResult;
let roster: unknown[];
let refuseDelete: string | null;
let callAction: ReturnType<typeof vi.spyOn>;
const shareCalls = () =>
  callAction.mock.calls.map(([info]) => info as ActionInfo).filter((info) => info.name === 'share');
const deleteCalls = () =>
  callAction.mock.calls
    .map(([info]) => info as ActionInfo)
    .filter((info) => info.name === 'members' && info.method === 'DELETE');

beforeEach(() => {
  shareResult = EMPTY_RESULT;
  roster = ROSTER;
  refuseDelete = null;
  callAction = vi.spyOn(dataManager, 'callAction').mockImplementation((info: ActionInfo) => {
    if (info.name === 'members' && info.method === 'DELETE' && refuseDelete) {
      return Promise.reject(new Error(refuseDelete));
    }
    if (info.name === 'members') return Promise.resolve(roster);
    if (info.name === 'share') {
      return Promise.resolve({ type: Project.type, id: PROJECT_ID, share_result: shareResult });
    }
    return Promise.resolve(null);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openInvite(entity: Project | Conversation) {
  h.entity = entity;
  render(<MembersAvatarStack typeId={new TypeId(entity.typeId.type, entity.id)} inviteRoles={['member', 'admin']} />);
  fireEvent.click(screen.getByTestId('members-avatar-stack'));
  // The form shows once my roster row (editor) has loaded.
  await screen.findByTestId('members-invite-form');
}

const input = () => screen.getByTestId('members-invite-input');
const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
const teamOption = () => screen.queryByTestId(`contact-team-option-${SANDBOX.id}`);
const teamRows = () => screen.queryAllByTestId(`members-invite-row-team-${SANDBOX.id}`);
const teamRole = () => screen.getByTestId(`members-invite-role-team-${SANDBOX.id}`);

describe('members popover on a Project — teams', () => {
  it('suggests sandbox-team as an editor types "sand"; picking it adds one row with the role fixed to member, picking again adds nothing', async () => {
    await openInvite(PROJECT);

    type('sand');
    expect(teamOption()).toHaveTextContent('sandbox-team');
    fireEvent.click(teamOption()!);

    expect(teamRows()).toHaveLength(1);
    expect(teamRows()[0]).toHaveTextContent('sandbox-team');
    expect(teamRole().value).toBe('member');
    expect(teamRole()).toBeDisabled();

    type('sand');
    fireEvent.click(teamOption()!);
    expect(teamRows()).toHaveLength(1);
  });

  it('applies a person and a team as ONE share action carrying recipients and teams', async () => {
    await openInvite(PROJECT);

    type('Noa');
    fireEvent.click(screen.getByTestId('members-invite-add'));
    type('sand');
    fireEvent.click(teamOption()!);
    fireEvent.click(screen.getByTestId('members-invite-submit'));

    await waitFor(() => expect(shareCalls()).toHaveLength(1));
    expect(shareCalls()[0].bodyParameters).toEqual({
      recipients: [{ idOrEmail: 'noa@example.com', role: 'member' }],
      teams: [`team-${SANDBOX.id}`],
    });
    // Sent: the list and the team chip clear.
    await waitFor(() => expect(teamRows()).toHaveLength(0));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  async function applyTeam() {
    await openInvite(PROJECT);
    type('sand');
    fireEvent.click(teamOption()!);
    fireEvent.click(screen.getByTestId('members-invite-submit'));
  }

  it('reports a refused team grant with the hub message when nothing else landed', async () => {
    // Nothing succeeded, so the share throws (inviteFailure) and the form shows
    // the hub's sentence as its error.
    shareResult = {
      ...EMPTY_RESULT,
      failed_teams: [{ team: `team-${SANDBOX.id}`, name: null, status: 403, message: 'not allowed' }],
    };
    await applyTeam();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`team-${SANDBOX.id}`);
    expect(alert).toHaveTextContent('not allowed');
  });

  it('names a refused team beside a person who was invited', async () => {
    shareResult = {
      ...EMPTY_RESULT,
      invited: [{ user_id: 'u-noa', email: 'noa@example.com', name: 'Noa', conversation_id: 'c' }],
      failed_teams: [{ team: `team-${SANDBOX.id}`, name: 'sandbox-team', status: 403, message: 'not allowed' }],
    };
    await openInvite(PROJECT);
    type('Noa');
    fireEvent.click(screen.getByTestId('members-invite-add'));
    type('sand');
    fireEvent.click(teamOption()!);
    fireEvent.click(screen.getByTestId('members-invite-submit'));

    const row = await screen.findByTestId('members-invite-failed-team');
    expect(row).toHaveTextContent('sandbox-team');
    expect(row).toHaveTextContent('not allowed');
  });

  it('warns when a team was granted but its invite message was not sent', async () => {
    shareResult = {
      ...EMPTY_RESULT,
      granted_teams: [{ team: `team-${SANDBOX.id}`, name: 'sandbox-team', conversation_id: null }],
    };
    await applyTeam();

    expect(await screen.findByTestId('members-invite-team-no-message')).toHaveTextContent('sandbox-team');
    expect(screen.queryByTestId('members-invite-failed-team')).toBeNull();
  });

  it('says nothing more when a team was granted with its conversation', async () => {
    shareResult = {
      ...EMPTY_RESULT,
      granted_teams: [{ team: `team-${SANDBOX.id}`, name: 'sandbox-team', conversation_id: 'conv-1' }],
    };
    await applyTeam();

    await waitFor(() => expect(teamRows()).toHaveLength(0));
    expect(screen.queryByTestId('members-invite-team-no-message')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says a team already had access', async () => {
    shareResult = {
      ...EMPTY_RESULT,
      skipped_teams: [{ team: `team-${SANDBOX.id}`, name: 'sandbox-team', reason: 'already_granted' }],
    };
    await applyTeam();

    expect(await screen.findByTestId('members-invite-team-already-granted')).toHaveTextContent('sandbox-team');
  });

  it('shows a failed person even when another invite landed', async () => {
    shareResult = {
      ...EMPTY_RESULT,
      invited: [{ user_id: 'u-noa', email: 'noa@example.com', name: 'Noa', conversation_id: 'c' }],
      failed: [{ user_id: null, email: 'eli@example.com', status: 500, message: 'boom' }],
    };
    await openInvite(PROJECT);
    type('Noa');
    fireEvent.click(screen.getByTestId('members-invite-add'));
    fireEvent.click(screen.getByTestId('members-invite-submit'));

    const row = await screen.findByTestId('members-invite-failed-person');
    expect(row).toHaveTextContent('eli@example.com');
    expect(row).toHaveTextContent('boom');
  });
});

describe('members popover on a Project — a granted team on the roster', () => {
  async function openRoster() {
    roster = ROSTER_WITH_TEAM;
    await openInvite(PROJECT);
  }
  const teamRow = () => screen.getByText('sandbox-team').closest('li') as HTMLElement;

  it('is one row with the team icon, a locked role and no role selector', async () => {
    await openRoster();

    const row = teamRow();
    expect(row.querySelector('[data-testid="member-team-icon"]')).not.toBeNull();
    expect(row.querySelector('[data-testid="member-role-select"]')).toBeNull();
    expect(row).toHaveTextContent(/member/i);
  });

  it('can be removed by an editor, which revokes the grant by team id', async () => {
    await openRoster();

    fireEvent.click(teamRow().querySelector('[data-testid="member-remove"]') as HTMLElement);

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(deleteCalls()[0].bodyParameters).toMatchObject({ user_id: SANDBOX.id });
  });

  it('is already picked, so the team is not offered again', async () => {
    await openRoster();

    type('sand');

    expect(teamOption()).toBeDisabled();
  });

  it('shows the hub message when removing an inherited member is refused, and keeps the row', async () => {
    await openRoster();
    refuseDelete = 'Dana has access through a team';
    const dana = screen.getByText('Dana').closest('li') as HTMLElement;

    fireEvent.click(dana.querySelector('[data-testid="member-remove"]') as HTMLElement);

    expect(await screen.findByTestId('member-error')).toHaveTextContent('Dana has access through a team');
    expect(screen.getByText('Dana')).toBeInTheDocument();
  });
});

describe('members popover on a conversation', () => {
  it('offers no team', async () => {
    await openInvite(CONVERSATION);

    type('sand');

    expect(teamOption()).toBeNull();
  });
});

/**
 * Teams in the project MEMBERS popover's add-member form.
 *
 * On a Project, whoever can open the add-member form (an editor here, not only
 * an admin) is offered the hub teams this desk knows; a picked team is ONE chip,
 * never expanded client-side, and Apply sends people and teams through ONE
 * `share` action (`Project.invite`). A conversation never offers teams.
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
const ROSTER = [{ user_id: 'me-id', email: 'me@example.com', name: 'Me', role: 'editor' }];

const EMPTY_RESULT: ShareResult = { invited: [], skipped: [], failed: [], skipped_teams: [] };

let shareResult: ShareResult;
let callAction: ReturnType<typeof vi.spyOn>;
const shareCalls = () =>
  callAction.mock.calls.map(([info]) => info as ActionInfo).filter((info) => info.name === 'share');

beforeEach(() => {
  shareResult = EMPTY_RESULT;
  callAction = vi.spyOn(dataManager, 'callAction').mockImplementation((info: ActionInfo) => {
    if (info.name === 'members') return Promise.resolve(ROSTER);
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
const teamRole = () => screen.getByTestId(`members-invite-role-team-${SANDBOX.id}`) as HTMLSelectElement;

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

  it('names a team whose member list could not be read', async () => {
    shareResult = {
      ...EMPTY_RESULT,
      skipped_teams: [{ team: `team-${SANDBOX.id}`, name: 'sandbox-team', reason: 'not_listable' }],
    };
    await openInvite(PROJECT);

    type('sand');
    fireEvent.click(teamOption()!);
    fireEvent.click(screen.getByTestId('members-invite-submit'));

    expect(await screen.findByTestId('members-invite-skipped-teams')).toHaveTextContent('sandbox-team');
  });
});

describe('members popover on a conversation', () => {
  it('offers no team', async () => {
    await openInvite(CONVERSATION);

    type('sand');

    expect(teamOption()).toBeNull();
  });
});

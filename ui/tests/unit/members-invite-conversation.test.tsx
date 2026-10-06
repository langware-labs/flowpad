/**
 * Who may invite into a conversation, as the roster popover shows it. Mirrors
 * the hub: on a DIRECT conversation any member may bring in a member; a
 * HELPDESK ticket stays admin-run. Someone who can't invite is told so and
 * pointed at the owner, instead of seeing a roster with no add row.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Conversation, TypeId } from '@sdk';
import { MembersAvatarStack } from '@src/components/conversation/MembersAvatarStack';

let myRole = 'member';
let conversationKind: string | undefined = 'direct';

vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => ({ cloudUser: { id: 'me-id', email: 'me@example.com' }, currentUser: null }),
  useContext: () => ({ cloudLoginAvailable: true, isDesktop: true }),
  useProject: () => ({ project: null }),
}));

vi.mock('@src/hooks/use-members', () => ({
  useMembers: () => ({
    entity: { kind: conversationKind },
    members: [
      { user_id: 'me-id', email: 'me@example.com', name: 'Me', role: myRole },
      { user_id: 'eran-id', email: 'eran@example.com', name: 'Eran', role: 'owner' },
    ],
    addMembers: vi.fn(),
    removeMember: vi.fn(),
    setRole: vi.fn(),
    refresh: vi.fn(),
    available: true,
    reason: 'available',
    updating: false,
    stale: false,
  }),
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
  useContacts: () => ({ contacts: [], refetch: vi.fn() }),
}));
vi.mock('@src/components/contact-picker/use-contacts-groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/contact-picker/use-contacts-groups')>()),
  useContactsGroups: () => ({ groups: [], refetch: vi.fn() }),
}));
vi.mock('@src/components/contact-picker/AddressBookButton', () => ({ AddressBookButton: () => null }));

const CONVERSATION = new TypeId(Conversation.type, '11111111-1111-4111-8111-111111111111');

function openFromHeaderButton() {
  render(<MembersAvatarStack typeId={CONVERSATION} showInviteButton />);
  fireEvent.click(screen.getByTestId('members-invite-button'));
}

describe('MembersAvatarStack on a conversation', () => {
  beforeEach(() => {
    myRole = 'member';
    conversationKind = 'direct';
  });

  it('a member of a DIRECT conversation gets the invite form', () => {
    openFromHeaderButton();
    expect(screen.getByTestId('members-invite-form')).toBeTruthy();
    expect(screen.queryByTestId('members-invite-not-allowed')).toBeNull();
  });

  it('a member of a HELPDESK ticket is told to ask the owner, with no form', () => {
    conversationKind = 'helpdesk';
    openFromHeaderButton();
    expect(screen.queryByTestId('members-invite-form')).toBeNull();
    expect(screen.getByTestId('members-invite-not-allowed').textContent).toContain('Eran');
  });

  it('an editor of a HELPDESK ticket gets no form either (the hub would 403)', () => {
    conversationKind = 'helpdesk';
    myRole = 'editor';
    openFromHeaderButton();
    expect(screen.queryByTestId('members-invite-form')).toBeNull();
  });

  it('a reader of a DIRECT conversation cannot invite', () => {
    myRole = 'reader';
    openFromHeaderButton();
    expect(screen.queryByTestId('members-invite-form')).toBeNull();
    expect(screen.getByTestId('members-invite-not-allowed')).toBeTruthy();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationKind, TypeId } from '@sdk';
import { ConversationParticipants } from '@src/components/conversation/ConversationParticipants';
import { MembersAvatarStack } from '@src/components/conversation/MembersAvatarStack';

vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => ({
    cloudUser: { id: 'me-id', email: 'me@example.com' },
    currentUser: null,
  }),
  // Consumed by useLoginRequired (via MembersAvatarStack's sign-in gate).
  useContext: () => ({ cloudLoginAvailable: true, isDesktop: true }),
  // ContactPicker → useContactsGroups → useComputedGroups calls useProject for
  // the "Project Members" computed group. This test drives the roster through
  // the mocked `use-members` and has no project context, so the hook resolves
  // to no project — which is exactly what an unscoped picker sees.
  useProject: () => ({ project: null }),
}));

vi.mock('@src/hooks/use-members', () => ({
  useMembers: () => ({
    members: [
      { user_id: 'me-id', email: 'me@example.com', name: 'Me', role: 'owner' },
      { user_id: 'alice-id', email: 'alice@example.com', name: 'Alice', role: 'member' },
    ],
    addMembers: vi.fn(),
    removeMember: vi.fn(),
    setRole: vi.fn(),
    // Membership available (signed in) so the roster + controls render.
    available: true,
    reason: 'available',
    updating: false,
    stale: false,
  }),
}));

// The sign-in gate machinery is out of scope here — stub it so MembersAvatarStack
// renders without the agent-layout / router providers it would need at runtime.
vi.mock('@src/hooks/use-login-required', () => ({
  useLoginRequired: () => ({
    checkLoginAndProceed: () => true,
    showLoginDialog: false,
    closeLoginDialog: vi.fn(),
  }),
}));
vi.mock('@src/components/login-required-dialog', () => ({
  ActionType: { MEMBERS: 'members' },
  default: () => null, // LoginDialog is the default export
}));

vi.mock('@src/components/conversation/useLocalUser', () => ({
  useLocalUser: () => ({
    localUser: { id: 'me-id', email: 'me@example.com' },
  }),
}));

vi.mock('@src/components/conversation/ContactPermissionsDialog', () => ({
  ContactPermissionsDialog: ({
    open,
    contact,
  }: {
    open: boolean;
    contact: { userId?: string | null; email?: string | null; name?: string | null };
  }) => open ? (
    <div data-testid="contact-permissions-dialog">
      {contact.userId}|{contact.email}|{contact.name}
    </div>
  ) : null,
}));

describe('conversation participant permission dialogs', () => {
  it('opens permissions from the compact participant list', async () => {
    render(
      <ConversationParticipants
        kind={ConversationKind.DIRECT}
        participants={[
          { user_id: 'me-id', email: 'me@example.com', name: 'Me', role: 'owner' },
          { user_id: 'alice-id', email: 'alice@example.com', name: 'Alice', role: 'member' },
        ]}
      />,
    );

    fireEvent.click(screen.getByTestId('conversation-participants'));
    fireEvent.click(await screen.findByTestId('conversation-participant-contact-alice-id'));

    expect(screen.getByTestId('contact-permissions-dialog')).toHaveTextContent(
      'alice-id|alice@example.com|Alice',
    );
  });

  it('opens permissions from the editable member roster', async () => {
    render(<MembersAvatarStack typeId={new TypeId('conversation', '11111111-1111-4111-8111-111111111111')} />);

    fireEvent.click(screen.getByTestId('members-avatar-stack'));
    fireEvent.click(await screen.findByTestId('member-contact-alice-id'));

    expect(screen.getByTestId('contact-permissions-dialog')).toHaveTextContent(
      'alice-id|alice@example.com|Alice',
    );
  });
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';
import { MembersAvatarStack } from '@src/components/conversation/MembersAvatarStack';

const addMembers = vi.fn();
const myRole = 'owner';

vi.mock('@sdk/react/hooks', () => ({
  useAuth: () => ({ cloudUser: { id: 'me-id', email: 'me@example.com' }, currentUser: null }),
  useContext: () => ({ cloudLoginAvailable: true, isDesktop: true }),
  useProject: () => ({ project: null }),
}));

vi.mock('@src/hooks/use-members', () => ({
  useMembers: () => ({
    members: [
      { user_id: 'me-id', email: 'me@example.com', name: 'Me', role: myRole },
      { user_id: 'dana-id', email: 'dana@example.com', name: 'Dana', role: 'member' },
      { user_id: 'ari-id', email: 'ari@example.com', name: 'Ari', role: 'admin' },
    ],
    addMembers,
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

// The address book (contact store). Gadi Tunes is known only by hub id — the
// hub doesn't disclose other people's emails to a non-admin.
const CONTACTS = [
  { id: 'u-noa', email: 'noa@example.com', name: 'Noa' },
  { id: 'u-gadi', email: 'gadi@example.com', name: 'Gadi' },
  { id: 'u-tunes', user_id: 'hub-id-only', email: null, name: 'Gadi Tunes' },
];
vi.mock('@src/components/contact-picker/use-contacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/contact-picker/use-contacts')>()),
  useContacts: () => ({ contacts: CONTACTS, refetch: vi.fn() }),
}));
vi.mock('@src/components/contact-picker/use-contacts-groups', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/contact-picker/use-contacts-groups')>()),
  useContactsGroups: () => ({ groups: [], refetch: vi.fn() }),
}));
// The address-book modal is its own concern — stand in with a button that ticks
// the hub-id-only contact onto the (controlled) list.
vi.mock('@src/components/contact-picker/AddressBookButton', () => ({
  AddressBookButton: ({
    value,
    onChange,
  }: {
    value: { email?: string | null; user_id?: string; name?: string | null }[];
    onChange: (next: { email?: string | null; user_id?: string; name?: string | null }[]) => void;
  }) => (
    <button
      type="button"
      data-testid="address-book-tick-tunes"
      onClick={() => onChange([...value, { user_id: 'hub-id-only', name: 'Gadi Tunes' }])}
    />
  ),
}));

const PROJECT = new TypeId('project', '11111111-1111-4111-8111-111111111111');

const input = () => screen.getByTestId('members-invite-input');
const listRow = () => screen.queryByText('noa@example.com');

function queueNoa() {
  fireEvent.change(input(), { target: { value: 'noa@example.com' } });
  fireEvent.click(screen.getByTestId('members-invite-add'));
}
function closePane() {
  fireEvent.keyDown(input(), { key: 'Escape' });
}

// The langware-os share, 2026-10-05: Nir was added to the list, the pane closed,
// and no invite ever left the desktop — Apply is the only step that sends, and
// closing dropped the list without a word.
describe('an invite on the list is not lost by closing the pane', () => {
  beforeEach(() => {
    addMembers.mockReset();
  });

  it('keeps the person on the list across a close, says so on Invite, and Apply sends them', async () => {
    render(<MembersAvatarStack typeId={PROJECT} showInviteButton />);
    fireEvent.click(screen.getByTestId('members-invite-button'));
    queueNoa();
    closePane();

    await waitFor(() => expect(screen.queryByTestId('members-invite-input')).toBeNull());
    expect(screen.getByTestId('members-invite-unsent').textContent).toContain('1');
    expect(addMembers).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('members-invite-button'));
    expect(listRow()).toBeTruthy();
    fireEvent.click(screen.getByTestId('members-invite-submit'));

    await waitFor(() => expect(addMembers).toHaveBeenCalledTimes(1));
    expect(addMembers.mock.calls[0][0].map((u: { idOrEmail: string }) => u.idOrEmail)).toEqual(['noa@example.com']);
  });

  it('opens the pane once the prerequisite that held it back is met', () => {
    let proceed: (() => void) | null = null;
    render(
      <MembersAvatarStack
        typeId={PROJECT}
        showInviteButton
        beforeInvite={(next) => {
          proceed = next;
          return false;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('members-invite-button'));
    expect(screen.queryByTestId('members-invite-input')).toBeNull();

    act(() => proceed?.());

    expect(screen.getByTestId('members-invite-input')).toBeTruthy();
  });
});

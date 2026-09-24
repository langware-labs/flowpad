import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TypeId } from '@sdk';
import { MembersAvatarStack } from '@src/components/conversation/MembersAvatarStack';

const addMembers = vi.fn();
let myRole = 'owner';

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
const PROJECT_ROLES = ['member', 'admin'];

function openInvite(inviteRoles?: readonly string[]) {
  render(<MembersAvatarStack typeId={PROJECT} inviteRoles={inviteRoles} />);
  fireEvent.click(screen.getByTestId('members-avatar-stack'));
}

const input = () => screen.getByTestId('members-invite-input');
const addRole = () => screen.getByTestId('members-invite-role');
const rowRole = (key: string) => screen.getByTestId(`members-invite-role-${key}`);
const options = (select: HTMLSelectElement) => Array.from(select.options).map((o) => o.value);
const addButton = () => screen.getByTestId('members-invite-add');
const applyButton = () => screen.getByTestId('members-invite-submit');

function type(text: string) {
  fireEvent.change(input(), { target: { value: text } });
}
function chooseRole(role: string) {
  fireEvent.change(addRole(), { target: { value: role } });
}
function add() {
  fireEvent.click(addButton());
}

describe('invite form — type, pick a role, Add to the list, Apply', () => {
  beforeEach(() => {
    addMembers.mockReset();
    myRole = 'owner';
  });

  describe('role selector', () => {
    it('offers member and admin to an owner, defaulting to member', () => {
      openInvite(PROJECT_ROLES);

      expect(addRole().value).toBe('member');
      expect(options(addRole())).toEqual(['member', 'admin']);
    });

    it('caps the offer below my own rank — an admin cannot grant admin', () => {
      myRole = 'admin';
      openInvite(PROJECT_ROLES);

      expect(options(addRole())).toEqual(['member']);
    });

    it('lets an editor invite, capped below their own rank', () => {
      myRole = 'editor';
      openInvite(PROJECT_ROLES);

      expect(screen.getByTestId('members-invite-form')).toBeTruthy();
      expect(options(addRole())).toEqual(['member']);
    });

    it('shows a plain member the roster only — no invite form', () => {
      myRole = 'member';
      openInvite(PROJECT_ROLES);

      expect(screen.queryByTestId('members-invite-form')).toBeNull();
    });

    it('renders no role selector when the surface passes no roles', () => {
      openInvite();
      type('noa@example.com');
      add();

      expect(screen.queryByTestId('members-invite-role')).toBeNull();
      expect(document.querySelector('[data-testid^="members-invite-role-"]')).toBeNull();
    });
  });

  describe('Add', () => {
    it('lists a typed email at the chosen role without calling the backend', () => {
      openInvite(PROJECT_ROLES);

      type('new@example.com');
      chooseRole('admin');
      add();

      expect(rowRole('new@example.com').value).toBe('admin');
      expect(input().value).toBe('');
      expect(addMembers).not.toHaveBeenCalled();
    });

    it('takes the role whichever order it is picked in — role first, then email', () => {
      openInvite(PROJECT_ROLES);

      chooseRole('admin');
      type('new@example.com');
      add();

      expect(rowRole('new@example.com').value).toBe('admin');
    });

    it('resolves a typed name to the contact it names', () => {
      openInvite(PROJECT_ROLES);

      // "Gadi" also matches "Gadi Tunes" — the exact name wins.
      type('Gadi');
      add();

      expect(rowRole('gadi@example.com').value).toBe('member');
    });

    it('adds the contact picked from the suggestions', () => {
      openInvite(PROJECT_ROLES);

      type('no');
      fireEvent.click(screen.getByTestId('members-invite-suggestion-u-noa'));
      expect(input().value).toBe('Noa');
      add();

      expect(rowRole('noa@example.com')).toBeTruthy();
    });

    it('adds on Enter, like the button', () => {
      openInvite(PROJECT_ROLES);

      type('new@example.com');
      fireEvent.keyDown(input(), { key: 'Enter' });

      expect(rowRole('new@example.com')).toBeTruthy();
    });

    it('keeps each added person on their own row at their own role', () => {
      openInvite(PROJECT_ROLES);

      type('Noa');
      chooseRole('admin');
      add();
      type('Gadi');
      chooseRole('member');
      add();

      expect(rowRole('noa@example.com').value).toBe('admin');
      expect(rowRole('gadi@example.com').value).toBe('member');
      expect(screen.getByTestId('members-invite-count').textContent).toBe('2 to invite');
    });

    it('updates the role of someone already listed instead of listing them twice', () => {
      openInvite(PROJECT_ROLES);

      type('Noa');
      add();
      type('Noa');
      chooseRole('admin');
      add();

      expect(screen.getAllByTestId(/^members-invite-row-/)).toHaveLength(1);
      expect(rowRole('noa@example.com').value).toBe('admin');
    });

    it('refuses text that names no one', () => {
      openInvite(PROJECT_ROLES);

      type('nobody');
      add();

      expect(screen.getByRole('alert').textContent).toMatch(/enter a full email/);
      expect(screen.queryByTestId('members-invite-list')).toBeNull();
    });

    it('refuses someone already on the roster', () => {
      openInvite(PROJECT_ROLES);

      type('dana@example.com');
      add();

      expect(screen.getByRole('alert').textContent).toMatch(/Already a member/);
      expect(screen.queryByTestId('members-invite-list')).toBeNull();
    });

    it('is disabled until something is typed', () => {
      openInvite(PROJECT_ROLES);

      expect(addButton().disabled).toBe(true);
      type('n');
      expect(addButton().disabled).toBe(false);
    });

    it('lists an address-book pick at the add row role', () => {
      openInvite(PROJECT_ROLES);

      chooseRole('admin');
      fireEvent.click(screen.getByTestId('address-book-tick-tunes'));

      expect(rowRole('hub-id-only').value).toBe('admin');
    });

    it('drops a row with its remove button', () => {
      openInvite(PROJECT_ROLES);

      type('Noa');
      add();
      fireEvent.click(screen.getByTestId('members-invite-remove-noa@example.com'));

      expect(screen.queryByTestId('members-invite-list')).toBeNull();
    });
  });

  describe('Apply', () => {
    it('is disabled while the list is empty', () => {
      openInvite(PROJECT_ROLES);

      expect(applyButton().disabled).toBe(true);
    });

    it('sends every listed person with their role in one batch, then clears the list', async () => {
      addMembers.mockResolvedValue(undefined);
      openInvite(PROJECT_ROLES);

      type('Noa');
      add();
      type('Gadi');
      add();
      // A row's role can still change after Add.
      fireEvent.change(rowRole('noa@example.com'), { target: { value: 'admin' } });
      fireEvent.click(applyButton());

      await waitFor(() =>
        expect(addMembers).toHaveBeenCalledWith([
          { idOrEmail: 'noa@example.com', role: 'admin' },
          { idOrEmail: 'gadi@example.com', role: 'member' },
        ]),
      );
      await waitFor(() => expect(screen.queryByTestId('members-invite-list')).toBeNull());
    });

    it('invites a user-id-only contact by hub id instead of dropping them, regression for Gadi Tunes', async () => {
      // Regression: a contact with no email on file (the hub doesn't disclose
      // other people's emails) used to be silently dropped because the invite
      // path only ever collected emails.
      openInvite(PROJECT_ROLES);

      type('tunes');
      add();
      fireEvent.change(rowRole('hub-id-only'), { target: { value: 'admin' } });
      fireEvent.click(applyButton());

      await waitFor(() => expect(addMembers).toHaveBeenCalledWith([{ idOrEmail: 'hub-id-only', role: 'admin' }]));
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('sends no role when the surface offers no roles', async () => {
      openInvite();

      type('noa@example.com');
      add();
      fireEvent.click(screen.getByTestId('address-book-tick-tunes'));
      fireEvent.click(applyButton());

      await waitFor(() =>
        expect(addMembers).toHaveBeenCalledWith([
          { idOrEmail: 'noa@example.com', role: undefined },
          { idOrEmail: 'hub-id-only', role: undefined },
        ]),
      );
    });

    it('keeps the list and shows the error when the backend refuses', async () => {
      addMembers.mockRejectedValue(new Error('Hub said no'));
      openInvite(PROJECT_ROLES);

      type('Noa');
      add();
      fireEvent.click(applyButton());

      expect((await screen.findByRole('alert')).textContent).toBe('Hub said no');
      expect(rowRole('noa@example.com')).toBeTruthy();
    });
  });
});

describe('roster — remove (✕) follows the hub ladder', () => {
  const CONVERSATION = new TypeId('conversation', '22222222-2222-4222-8222-222222222222');
  const removable = () => screen.queryAllByTestId('member-remove').map((b) => b.getAttribute('aria-label'));

  function openRoster(typeId: TypeId = PROJECT) {
    render(<MembersAvatarStack typeId={typeId} />);
    fireEvent.click(screen.getByTestId('members-avatar-stack'));
  }

  beforeEach(() => {
    myRole = 'owner';
  });

  it('lets a project owner remove everyone below them', () => {
    openRoster();

    expect(removable()).toEqual(['Remove Dana', 'Remove Ari']);
  });

  it('lets a project editor remove a member, not an admin', () => {
    myRole = 'editor';
    openRoster();

    expect(removable()).toEqual(['Remove Dana']);
  });

  it('lets a project admin remove a member, not a peer admin', () => {
    myRole = 'admin';
    openRoster();

    expect(removable()).toEqual(['Remove Dana']);
  });

  it('gives a plain project member no remove at all', () => {
    myRole = 'member';
    openRoster();

    expect(removable()).toEqual([]);
  });

  it('keeps conversation removal owner-only, as the hub does', () => {
    myRole = 'admin';
    openRoster(CONVERSATION);
    expect(removable()).toEqual([]);
  });

  it('lets a conversation owner remove anyone else', () => {
    openRoster(CONVERSATION);

    expect(removable()).toEqual(['Remove Dana', 'Remove Ari']);
  });
});

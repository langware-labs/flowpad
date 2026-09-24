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
    members: [{ user_id: 'me-id', email: 'me@example.com', name: 'Me', role: myRole }],
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
vi.mock('@src/components/contact-picker/AddressBookButton', () => ({ AddressBookButton: () => null }));
// Picking a contact is ContactPicker's own concern — stand in with two buttons that stage
// Noa/Gadi onto the existing (controlled) selection, so a test can build a multi-recipient batch.
vi.mock('@src/components/contact-picker/ContactPicker', () => ({
  ContactPicker: ({
    value,
    onChange,
  }: {
    value: { email?: string; user_id?: string; name?: string }[];
    onChange: (next: { email?: string; user_id?: string; name?: string }[]) => void;
  }) => (
    <>
      <button type="button" data-testid="pick-noa" onClick={() => onChange([...value, { email: 'noa@example.com', name: 'Noa' }])} />
      <button
        type="button"
        data-testid="pick-gadi"
        onClick={() => onChange([...value, { email: 'gadi@example.com', name: 'Gadi' }])}
      />
      {/* The address book can stage a contact known only by hub id — the hub
          doesn't disclose other people's emails to a non-admin. */}
      <button
        type="button"
        data-testid="pick-user-id-only"
        onClick={() => onChange([...value, { user_id: 'hub-id-only', name: 'Gadi Tunes' }])}
      />
    </>
  ),
}));

const PROJECT = new TypeId('project', '11111111-1111-4111-8111-111111111111');

function openInvite(inviteRoles?: readonly string[]) {
  render(<MembersAvatarStack typeId={PROJECT} inviteRoles={inviteRoles} />);
  fireEvent.click(screen.getByTestId('members-avatar-stack'));
}

function roleSelect(email: string): HTMLSelectElement {
  return screen.getByTestId(`members-invite-role-${email}`);
}

function offered(email: string): string[] {
  return Array.from(roleSelect(email).options).map((o) => o.value);
}

describe('project invite — per-recipient role picker', () => {
  beforeEach(() => {
    addMembers.mockReset();
    myRole = 'owner';
  });

  it('offers member and admin to an owner, defaulting to member', async () => {
    openInvite(['member', 'admin']);

    fireEvent.click(screen.getByTestId('pick-noa'));

    const select = (await screen.findByTestId('members-invite-role-noa@example.com')) as HTMLSelectElement;
    expect(select.value).toBe('member');
    expect(offered('noa@example.com')).toEqual(['member', 'admin']);
  });

  it('caps the offer below my own rank — an admin cannot grant admin', async () => {
    myRole = 'admin';
    openInvite(['member', 'admin']);

    fireEvent.click(screen.getByTestId('pick-noa'));
    await screen.findByTestId('members-invite-role-noa@example.com');

    expect(offered('noa@example.com')).toEqual(['member']);
  });

  it('renders no picker when the surface passes no roles', async () => {
    openInvite();

    fireEvent.click(screen.getByTestId('pick-noa'));
    await screen.findByTestId('members-invite-submit');

    expect(document.querySelector('[data-testid^="members-invite-role-"]')).toBeNull();
    expect(screen.queryByTestId('members-invite-role')).toBeNull();
  });

  it('offers the add-row default selector, defaulting to member', async () => {
    openInvite(['member', 'admin']);

    const select = (await screen.findByTestId('members-invite-role')) as HTMLSelectElement;
    expect(select.value).toBe('member');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['member', 'admin']);
  });

  it('seeds a newly-staged recipient from the add-row selector', async () => {
    openInvite(['member', 'admin']);

    fireEvent.change(await screen.findByTestId('members-invite-role'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByTestId('pick-noa'));

    const row = (await screen.findByTestId('members-invite-role-noa@example.com')) as HTMLSelectElement;
    expect(row.value).toBe('admin');
  });

  it('gives each staged recipient their own row and role', async () => {
    openInvite(['member', 'admin']);

    fireEvent.click(screen.getByTestId('pick-noa'));
    fireEvent.click(await screen.findByTestId('pick-gadi'));

    expect(await screen.findByTestId('members-invite-role-noa@example.com')).toBeTruthy();
    expect(screen.getByTestId('members-invite-role-gadi@example.com')).toBeTruthy();
  });

  it('sends a different role per recipient with the invite', async () => {
    openInvite(['member', 'admin']);

    fireEvent.click(screen.getByTestId('pick-noa'));
    fireEvent.click(await screen.findByTestId('pick-gadi'));
    // Noa gets admin; Gadi is left at the default (member).
    fireEvent.change(screen.getByTestId('members-invite-role-noa@example.com'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByTestId('members-invite-submit'));

    await waitFor(() =>
      expect(addMembers).toHaveBeenCalledWith([
        { idOrEmail: 'noa@example.com', role: 'admin' },
        { idOrEmail: 'gadi@example.com', role: 'member' },
      ]),
    );
  });

  it('sends no role when the surface offers no roles', async () => {
    openInvite();

    fireEvent.click(screen.getByTestId('pick-noa'));
    fireEvent.click(await screen.findByTestId('members-invite-submit'));

    await waitFor(() =>
      expect(addMembers).toHaveBeenCalledWith([{ idOrEmail: 'noa@example.com', role: undefined }]),
    );
  });

  it('invites a user-id-only contact instead of dropping them, regression for Gadi Tunes', async () => {
    // Regression: the address book can stage a contact with no email on file
    // (the hub doesn't disclose other people's emails). This used to be
    // silently dropped ("Pick a contact or enter an email" even with a chip
    // visibly staged) because the invite path only ever collected emails.
    openInvite();

    fireEvent.click(screen.getByTestId('pick-user-id-only'));
    fireEvent.click(screen.getByTestId('members-invite-submit'));

    await waitFor(() =>
      expect(addMembers).toHaveBeenCalledWith([{ idOrEmail: 'hub-id-only', role: undefined }]),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gives a user-id-only contact its own role row, keyed by hub id', async () => {
    openInvite(['member', 'admin']);

    fireEvent.click(screen.getByTestId('pick-user-id-only'));

    const row = (await screen.findByTestId('members-invite-role-hub-id-only')) as HTMLSelectElement;
    expect(row.value).toBe('member');
    fireEvent.change(row, { target: { value: 'admin' } });
    fireEvent.click(screen.getByTestId('members-invite-submit'));

    await waitFor(() =>
      expect(addMembers).toHaveBeenCalledWith([{ idOrEmail: 'hub-id-only', role: 'admin' }]),
    );
  });

  it('invites an email recipient and a user-id-only recipient together, one submission', async () => {
    openInvite();

    fireEvent.click(screen.getByTestId('pick-noa'));
    fireEvent.click(await screen.findByTestId('pick-user-id-only'));
    fireEvent.click(screen.getByTestId('members-invite-submit'));

    await waitFor(() =>
      expect(addMembers).toHaveBeenCalledWith([
        { idOrEmail: 'noa@example.com', role: undefined },
        { idOrEmail: 'hub-id-only', role: undefined },
      ]),
    );
  });
});

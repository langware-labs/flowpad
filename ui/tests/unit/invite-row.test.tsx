/**
 * `InviteRow` — the address + role + Send box used wherever an organization or team is shared.
 *
 * The rule worth locking at this level is the one a person actually sees: the role menu offers only
 * roles BELOW the caller's own, mirroring the hub's `can_assign`. `grantableRoles` is unit-tested
 * on its own (`participant_roles.test.ts`); this checks it is really what fills the dropdown, and
 * that the default selection is never a role the hub would refuse — the menu used to be a flat
 * list with `admin` at the top and preselected nothing, so an admin's first, most natural action
 * was the one that always came back refused.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getByTypeId: vi.fn(), inviteMember: vi.fn() }));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), getByTypeId: h.getByTypeId },
  };
});

import { TypeId } from '@sdk';
import { InviteRow } from '@src/components/organization/invite-row';

const ORG = new TypeId('organization', '550e8400-e29b-41d4-a716-446655440001');

const owner = { user_id: 'u-owner', email: 'o@x.test', role: 'owner' };
const admin = { user_id: 'u-admin', email: 'a@x.test', role: 'admin' };

function draw(me: unknown) {
  const onInvited = vi.fn();
  render(<InviteRow entityTypeId={ORG} me={me as never} onInvited={onInvited} />);
  return { onInvited };
}

function roleOptions(): string[] {
  const select = screen.getByTestId<HTMLSelectElement>('org-invite-role');
  return Array.from(select.options).map((o) => o.value);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.getByTypeId.mockResolvedValue({ inviteMember: h.inviteMember });
  h.inviteMember.mockResolvedValue(undefined);
});

describe('InviteRow', () => {
  it('offers an owner the whole ladder', () => {
    draw(owner);
    expect(roleOptions()).toEqual(['admin', 'editor', 'member', 'reader']);
  });

  it('does not offer an admin the ability to create another admin', () => {
    draw(admin);
    expect(roleOptions()).toEqual(['editor', 'member', 'reader']);
  });

  it('defaults to member, which both of them may confer', () => {
    draw(admin);
    expect(screen.getByTestId<HTMLSelectElement>('org-invite-role').value).toBe('member');
  });

  it('offers nothing to a caller with no resolvable rank', () => {
    // Unreachable in the product — both call sites wait for the roster — but the safe direction to
    // fail is offering no role rather than every role.
    draw(null);
    expect(roleOptions()).toEqual([]);
  });

  it('sends the address and the chosen role, then reports upward', async () => {
    const { onInvited } = draw(admin);
    fireEvent.change(screen.getByTestId('org-invite-email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByTestId('org-invite-role'), { target: { value: 'reader' } });
    fireEvent.click(screen.getByTestId('org-invite-submit'));

    await waitFor(() => expect(h.inviteMember).toHaveBeenCalledWith('new@example.com', 'reader'));
    expect(onInvited).toHaveBeenCalled();
  });

  it('sends nothing when no address has been typed', () => {
    draw(admin);
    expect(screen.getByTestId<HTMLButtonElement>('org-invite-submit').disabled).toBe(true);
  });
});

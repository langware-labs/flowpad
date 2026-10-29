import { describe, expect, it } from 'vitest';
import { ROLE_ORDER, roleCapabilities, canManageRoles, normalizeRoles } from '@sdk';
import { assignableRoles, canInviteMembers, grantableRoles, participantRoleLabel } from '@src/components/conversation/participant-display';
const owner = { user_id: 'owner', roles: ['owner'] };
const admin = { user_id: 'admin', roles: ['admin'] };
const reader = { user_id: 'reader', roles: ['reader'] };
const runner = { user_id: 'runner', roles: ['runner'] };
describe('canonical capability sets', () => {
  it('keeps Reader and Runner independent and Editor includes both', () => {
    expect([...roleCapabilities(reader.roles)]).toEqual(['reader']);
    expect([...roleCapabilities(runner.roles)]).toEqual(['runner']);
    expect(roleCapabilities(['editor'])).toEqual(new Set(['editor', 'reader', 'runner']));
    expect(ROLE_ORDER).toEqual(['owner','owner_by_api','admin','editor','reader','runner']);
  });
  it('rejects obsolete roles', () => {
    for (const role of ['guest','member','spender','full-access','anonymous_viewer']) expect(() => normalizeRoles([role])).toThrow();
  });
  it('offers grants from the registry, never owner or owner_by_api', () => {
    expect(grantableRoles(owner)).toEqual(['admin','editor','reader','runner']);
    expect(grantableRoles(admin)).toEqual(['editor','reader','runner']);
    expect(grantableRoles(reader)).toEqual([]);
    expect(grantableRoles(runner)).toEqual([]);
  });
  it('checks every target role without ranking Reader against Runner', () => {
    expect(assignableRoles(owner, { user_id:'target',roles:['reader','runner'] })).toEqual(grantableRoles(owner));
    expect(assignableRoles(owner, owner)).toEqual([]);
    expect(assignableRoles(admin, owner)).toEqual([]);
    expect(canManageRoles(['reader'], ['runner'])).toBe(false);
    expect(canManageRoles(['runner'], ['reader'])).toBe(false);
  });
  it('displays the full role set and checks the exact invite capability', () => {
    expect(participantRoleLabel({roles:['reader','runner']})).toBe('reader, runner');
    expect(canInviteMembers(reader, 'conversation')).toBe(true);
    expect(canInviteMembers(runner, 'conversation')).toBe(true);
    expect(canInviteMembers(admin)).toBe(true);
  });
});

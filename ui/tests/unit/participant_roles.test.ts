/**
 * Rank-gating mirror of the hub's ``can_assign`` (role_hierarchy.py) — locks
 * the UI affordance rules: assign strictly below my rank, on members strictly
 * below my rank, never self / the owner; invite is admin-and-above.
 */
import { describe, expect, it } from 'vitest';
import {
  assignableRoles,
  canInviteMembers,
  grantableRoles,
  participantRank,
} from '@src/components/conversation/participant-display';

const owner = { user_id: 'u-owner', email: 'o@x.test', role: 'owner' };
const admin = { user_id: 'u-admin', email: 'a@x.test', role: 'admin' };
const editor = { user_id: 'u-editor', email: 'e@x.test', role: 'editor' };
const member = { user_id: 'u-member', email: 'm@x.test', role: 'member' };

describe('participantRank', () => {
  it('ranks the standard ladder, case/whitespace-insensitively', () => {
    expect(participantRank({ role: 'owner' })).toBe(0);
    expect(participantRank({ role: ' Admin ' })).toBe(2);
    expect(participantRank({ role: 'reader' })).toBe(5);
  });

  it('takes the highest rank from a comma-joined multi-role field', () => {
    // The hub joins multi-role members as "a, b" (get_approved_members).
    expect(participantRank({ role: 'reader, admin' })).toBe(2);
  });

  it('returns null for custom/unknown/absent roles', () => {
    expect(participantRank({ role: 'restricted' })).toBeNull();
    expect(participantRank({ role: '' })).toBeNull();
    expect(participantRank(null)).toBeNull();
  });
});

describe('assignableRoles (can_assign mirror)', () => {
  it('owner manages everyone below: full menu on a member', () => {
    expect(assignableRoles(owner, member)).toEqual(['admin', 'editor', 'member', 'reader']);
  });

  it('owner can change an admin (only the owner manages admins)', () => {
    expect(assignableRoles(owner, admin)).toEqual(['admin', 'editor', 'member', 'reader']);
  });

  it('admin manages editor/member/reader but offers only roles below admin', () => {
    expect(assignableRoles(admin, member)).toEqual(['editor', 'member', 'reader']);
  });

  it('never offers owner — not strictly below anyone', () => {
    expect(assignableRoles(owner, member)).not.toContain('owner');
  });

  it('peers and above are untouchable', () => {
    expect(assignableRoles(admin, admin)).toEqual([]); // peer rank
    expect(assignableRoles(editor, admin)).toEqual([]); // above me
    expect(assignableRoles(member, owner)).toEqual([]); // the owner
  });

  it('self-change is banned even for the owner', () => {
    expect(assignableRoles(owner, owner)).toEqual([]);
    expect(assignableRoles({ ...admin }, { ...admin })).toEqual([]);
  });

  it('no affordance when either rank is unresolved (custom role / not on roster)', () => {
    expect(assignableRoles(null, member)).toEqual([]);
    expect(assignableRoles(owner, { user_id: 'u-x', role: 'restricted' })).toEqual([]);
  });
});

describe('canInviteMembers', () => {
  it('admin and above may invite; lower roles may not', () => {
    expect(canInviteMembers(owner)).toBe(true);
    expect(canInviteMembers(admin)).toBe(true);
    expect(canInviteMembers(editor)).toBe(false);
    expect(canInviteMembers(member)).toBe(false);
    expect(canInviteMembers(null)).toBe(false);
  });
});

/**
 * Inviting somebody NEW. `assignableRoles` cannot answer this — an invite has no target yet, so it
 * correctly bails and a picker built on it would render empty. The ceiling is the half that still
 * applies, and it is the half with the rule in it.
 */
describe('grantableRoles', () => {
  it('lets an owner hand out every assignable role', () => {
    expect(grantableRoles(owner)).toEqual(['admin', 'editor', 'member', 'reader']);
  });

  it('does not let an admin create another admin', () => {
    // The hub's `can_assign` refuses a role at or above the granter's own, so offering `admin`
    // here put the one entry that could never work at the top of the menu.
    expect(grantableRoles(admin)).toEqual(['editor', 'member', 'reader']);
    expect(grantableRoles(admin)).not.toContain('admin');
  });

  it('narrows further down the ladder', () => {
    expect(grantableRoles(editor)).toEqual(['member', 'reader']);
    expect(grantableRoles(member)).toEqual(['reader']);
  });

  it('grants nothing when the caller has no resolvable rank', () => {
    // Both call sites render the picker only once the roster has resolved, so this is unreachable
    // in practice — and guessing "the whole ladder" when we do not know who is asking is the wrong
    // direction to be wrong in.
    expect(grantableRoles(null)).toEqual([]);
    expect(grantableRoles({ role: 'something-custom' })).toEqual([]);
  });
});

/**
 * `createChildTeam` — the two writes a team creation needs, in order.
 *
 * Both matter and neither alone is a team anyone can use: the scoped create writes containment
 * (parent → team, which is what gives the parent's own members a role on the new team), and the
 * group-member grant writes membership (team → parent, which is what puts the team in the
 * parent's roster). Containment alone produces a team nobody can find; membership alone produces
 * one its creator cannot administer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  save: vi.fn(),
  getByTypeId: vi.fn(),
  addGroupMember: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), save: h.save, getByTypeId: h.getByTypeId },
  };
});

import { TypeId } from '@sdk';

import { createChildTeam } from '@src/components/organization/create-child-team';

const ORG = new TypeId('organization', '550e8400-e29b-41d4-a716-446655440000');

afterEach(() => {
  vi.clearAllMocks();
});

describe('createChildTeam', () => {
  it('writes containment first, then membership, on the newly created team', async () => {
    h.save.mockResolvedValue(undefined);
    h.getByTypeId.mockResolvedValue({ addGroupMember: h.addGroupMember });
    h.addGroupMember.mockResolvedValue(undefined);

    const teamTypeId = await createChildTeam(ORG, 'Platform');

    expect(teamTypeId.type).toBe('team');
    // The scoped create names the ORG as scope, and carries the team's own name.
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'team' }),
      [ORG],
      expect.objectContaining({ name: 'Platform' }),
    );
    // Membership is granted on the SAME team the create just made, not a re-derived id.
    const createdTeamTypeId = h.save.mock.calls[0][0];
    expect(h.getByTypeId).toHaveBeenCalledWith(ORG);
    expect(h.addGroupMember).toHaveBeenCalledWith(createdTeamTypeId, 'member');
  });

  it('refuses to grant membership when the parent could not be loaded', async () => {
    h.save.mockResolvedValue(undefined);
    h.getByTypeId.mockResolvedValue(null);

    await expect(createChildTeam(ORG, 'Orphan')).rejects.toThrow('Parent entity not loaded');
    expect(h.addGroupMember).not.toHaveBeenCalled();
  });
});

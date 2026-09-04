/**
 * Who "share this project with the team" actually reaches.
 *
 * Locked here: the walk descends into teams nested in the team (a team confers
 * its role on everyone inside it, so stopping at the first level would miss most
 * of a school), it de-dupes a person who appears at two levels, it counts rather
 * than silently drops a roster row with no email — invitations travel by address
 * — and a membership cycle terminates instead of recursing forever.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMembers: vi.fn(),
}));

import { getMembers, TypeId } from '@sdk';
import { collectTeamRecipients } from '@src/components/organization/budgets/team-recipients';

const mockedGetMembers = vi.mocked(getMembers);

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const T1 = UUID(1);
const T2 = UUID(2);

const person = (email: string | null, name = 'Someone') => ({ user_id: `u-${email ?? name}`, email, name });
const team = (id: string, name = 'A team') => ({ user_id: null, id, type: 'team', name });

// Braces matter: a value RETURNED from `beforeEach` is treated as that test's
// cleanup function, and `mockReset()` returns the mock — so the arrow-body form
// had vitest calling `getMembers()` with no arguments after every test.
beforeEach(() => {
  mockedGetMembers.mockReset();
});

function rosters(map: Record<string, unknown[]>) {
  mockedGetMembers.mockImplementation((typeId: TypeId) => Promise.resolve((map[typeId.toString()] ?? []) as never));
}

describe('collectTeamRecipients', () => {
  it('takes the team’s own people', async () => {
    rosters({ [`team-${T1}`]: [person('Ada@Example.com'), person('grace@example.com')] });

    const result = await collectTeamRecipients(new TypeId('team', T1));

    // Lower-cased: the invitation is keyed by address, and the hub normalizes.
    expect(result.emails).toEqual(['ada@example.com', 'grace@example.com']);
    expect(result.unreachable).toBe(0);
  });

  it('descends into a nested team and de-dupes a shared member', async () => {
    rosters({
      [`team-${T1}`]: [person('ada@example.com'), team(T2)],
      [`team-${T2}`]: [person('grace@example.com'), person('ada@example.com')],
    });

    const result = await collectTeamRecipients(new TypeId('team', T1));

    expect(result.emails.sort()).toEqual(['ada@example.com', 'grace@example.com']);
  });

  it('counts people with no address instead of dropping them', async () => {
    rosters({ [`team-${T1}`]: [person('ada@example.com'), person(null, 'No Address'), person('', 'Blank')] });

    const result = await collectTeamRecipients(new TypeId('team', T1));

    expect(result.emails).toEqual(['ada@example.com']);
    expect(result.unreachable).toBe(2);
  });

  it('terminates on a membership cycle', async () => {
    rosters({
      [`team-${T1}`]: [person('ada@example.com'), team(T2)],
      [`team-${T2}`]: [person('grace@example.com'), team(T1)],
    });

    const result = await collectTeamRecipients(new TypeId('team', T1));

    expect(result.emails.sort()).toEqual(['ada@example.com', 'grace@example.com']);
    // Each team read exactly once — the visited guard, not luck.
    expect(mockedGetMembers).toHaveBeenCalledTimes(2);
  });
});

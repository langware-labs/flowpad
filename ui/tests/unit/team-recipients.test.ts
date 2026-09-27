/**
 * The "N people will be invited" preview for sharing a project with a team.
 *
 * Only a count — the backend expands the team again at send time. Locked here:
 * the walk descends into teams nested in the team (a team confers its role on
 * everyone inside it), it de-dupes a person who appears at two levels, people are
 * keyed by hub `user_id` (else email), pending rows are invitations rather than
 * members and are left out, an approved row with nothing to send to is counted
 * rather than dropped silently, a nested team whose member list refuses the
 * sharer contributes nobody (the picked team's own refusal is the dialog's
 * error), and a membership cycle terminates instead of recursing forever.
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

const person = (userId: string | null, email: string | null = null, status = 'approved', name = 'Someone') => ({
  type: 'user',
  user_id: userId,
  email,
  name,
  status,
});
const team = (id: string, name = 'A team') => ({ user_id: null, id, type: 'team', name, status: 'approved' });

// Braces matter: a value RETURNED from `beforeEach` is treated as that test's
// cleanup function, and `mockReset()` returns the mock — so the arrow-body form
// had vitest calling `getMembers()` with no arguments after every test.
beforeEach(() => {
  mockedGetMembers.mockReset();
});

function rosters(map: Record<string, unknown[] | Error>) {
  mockedGetMembers.mockImplementation((typeId: TypeId) => {
    const rows = map[typeId.toString()] ?? [];
    return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows as never);
  });
}

function forbidden(): Error {
  return Object.assign(new Error('Request failed with status code 403'), {
    response: { status: 403, data: { detail: 'Forbidden' } },
  });
}

describe('collectTeamRecipients', () => {
  it('counts the team’s own people, keyed by user id, else email', async () => {
    rosters({ [`team-${T1}`]: [person('u-ada', 'Ada@Example.com'), person(null, 'Grace@Example.com')] });

    const result = await collectTeamRecipients(new TypeId('team', T1));

    expect(result.people).toEqual(['u-ada', 'email:grace@example.com']);
    expect(result.unreachable).toBe(0);
  });

  it('descends into a nested team and de-dupes a shared member', async () => {
    rosters({
      [`team-${T1}`]: [person('u-ada'), team(T2)],
      [`team-${T2}`]: [person('u-grace'), person('u-ada')],
    });

    const result = await collectTeamRecipients(new TypeId('team', T1));

    expect(result.people.sort()).toEqual(['u-ada', 'u-grace']);
  });

  it('leaves pending rows out — an invitation is not a team member', async () => {
    rosters({
      [`team-${T1}`]: [
        person('u-ada'),
        person('u-pending', null, 'pending'),
        person(null, 'invited@example.com', 'pending'),
      ],
    });

    const result = await collectTeamRecipients(new TypeId('team', T1));

    expect(result.people).toEqual(['u-ada']);
    expect(result.unreachable).toBe(0);
  });

  it('counts an approved row with neither id nor email instead of dropping it silently', async () => {
    rosters({ [`team-${T1}`]: [person('u-ada'), person(null, null)] });

    const result = await collectTeamRecipients(new TypeId('team', T1));

    expect(result.people).toEqual(['u-ada']);
    expect(result.unreachable).toBe(1);
  });

  it('a nested team whose member list refuses the sharer contributes nobody; the rest still count', async () => {
    rosters({
      [`team-${T1}`]: [person('u-ada'), team(T2, 'Locked')],
      [`team-${T2}`]: forbidden(),
    });

    const result = await collectTeamRecipients(new TypeId('team', T1));

    expect(result.people).toEqual(['u-ada']);
  });

  it('the picked team’s own refusal is thrown — the dialog shows it', async () => {
    rosters({ [`team-${T1}`]: forbidden() });

    await expect(collectTeamRecipients(new TypeId('team', T1))).rejects.toThrow('403');
  });

  it('terminates on a membership cycle', async () => {
    rosters({
      [`team-${T1}`]: [person('u-ada'), team(T2)],
      [`team-${T2}`]: [person('u-grace'), team(T1)],
    });

    const result = await collectTeamRecipients(new TypeId('team', T1));

    expect(result.people.sort()).toEqual(['u-ada', 'u-grace']);
    // Each team read exactly once — the visited guard, not luck.
    expect(mockedGetMembers).toHaveBeenCalledTimes(2);
  });
});

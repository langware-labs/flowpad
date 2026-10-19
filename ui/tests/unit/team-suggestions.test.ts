/**
 * Which teams the share autocomplete offers (R2).
 *
 * Locked here:
 *  - The hub teams (`remote`) the desk knows the user is in are offered, matched
 *    on the name as the sharer types ("ini" finds initech).
 *  - A team the desk knows only locally (not `remote`) has no hub roster to
 *    expand and is never offered.
 *  - A picked team is one participant keyed `team-<id>`, never its members.
 */
import { describe, expect, it } from 'vitest';
import { TypeId } from '@sdk';
import {
  filterTeams,
  isTeamParticipant,
  knownTeams,
  teamParticipant,
  teamTypeIdOf,
} from '@src/components/contact-picker/use-team-suggestions';
import { participantKey } from '@src/components/contact-picker/use-contacts';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const INITECH = { id: UUID(1), name: 'initech', remote: true };
const ZOO = { id: UUID(2), name: 'Inn club', remote: true };
const LOCAL_ONLY = { id: UUID(3), name: 'inibox', remote: false };

describe('knownTeams + filterTeams — typing "ini"', () => {
  it('offers initech', () => {
    expect(filterTeams(knownTeams([INITECH, ZOO]), 'ini')).toEqual([{ id: INITECH.id, name: 'initech' }]);
  });

  it('offers every hub team for an empty query', () => {
    expect(filterTeams(knownTeams([INITECH, ZOO]), '')).toHaveLength(2);
  });

  it('never offers a team that exists only on this desk', () => {
    expect(filterTeams(knownTeams([INITECH, LOCAL_ONLY]), 'ini')).toEqual([{ id: INITECH.id, name: 'initech' }]);
  });

  it('falls back to the id when a team has no name', () => {
    expect(knownTeams([{ id: ZOO.id, name: '  ', remote: true }])).toEqual([{ id: ZOO.id, name: ZOO.id }]);
  });
});

describe('teamParticipant — one chip, never expanded', () => {
  it('is a single team participant keyed team-<id>', () => {
    const p = teamParticipant({ id: INITECH.id, name: 'initech' });
    expect(p).toMatchObject({ kind: 'team', typeid: `team-${INITECH.id}`, name: 'initech' });
    expect(p.user_id ?? null).toBeNull();
    expect(p.email ?? null).toBeNull();
    expect(participantKey(p)).toBe(`team-${INITECH.id}`);
    expect(isTeamParticipant(p)).toBe(true);
    expect(teamTypeIdOf(p)?.toString()).toBe(new TypeId('team', INITECH.id).toString());
  });

  it('does not collide with a person who has the team’s name', () => {
    const person = { name: 'initech', email: null };
    expect(isTeamParticipant(person)).toBe(false);
    expect(participantKey(person)).not.toBe(participantKey(teamParticipant({ id: INITECH.id, name: 'initech' })));
  });
});

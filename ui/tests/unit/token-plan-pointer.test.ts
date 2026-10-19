/**
 * `token-plan-pointer` — the scope ↔ pointer round-trip and the scope picker.
 */
import { describe, expect, it } from 'vitest';

import {
  parseTokenPlanPointer,
  scopePointer,
  selectScope,
  tokenPlanPointer,
} from '@src/components/token-plan/token-plan-pointer';

const TEAM = '550e8400-e29b-41d4-a716-446655440000';

describe('parseTokenPlanPointer', () => {
  it('defaults to me', () => {
    expect(parseTokenPlanPointer(undefined)).toEqual({ kind: 'me' });
    expect(parseTokenPlanPointer('')).toEqual({ kind: 'me' });
    expect(parseTokenPlanPointer('me')).toEqual({ kind: 'me' });
    expect(parseTokenPlanPointer('nonsense/x')).toEqual({ kind: 'me' });
  });

  it('reads team, team/<id> and org', () => {
    expect(parseTokenPlanPointer('team')).toEqual({ kind: 'team' });
    expect(parseTokenPlanPointer(`team/${TEAM}`)).toEqual({ kind: 'team', id: TEAM });
    expect(parseTokenPlanPointer('org')).toEqual({ kind: 'org' });
    expect(parseTokenPlanPointer('/org/')).toEqual({ kind: 'org' });
  });
});

describe('tokenPlanPointer / scopePointer', () => {
  it('writes me as the empty pointer and round-trips the rest', () => {
    expect(tokenPlanPointer('me')).toBe('');
    expect(tokenPlanPointer('org')).toBe('org');
    expect(tokenPlanPointer('team', TEAM)).toBe(`team/${TEAM}`);
    expect(tokenPlanPointer('team')).toBe('team');
    expect(scopePointer({ kind: 'team', id: TEAM })).toBe(`team/${TEAM}`);
    expect(scopePointer({ kind: 'org', id: 'o' })).toBe('org');
    expect(scopePointer({ kind: 'me', id: 'u' })).toBe('');
    for (const p of ['', 'org', `team/${TEAM}`]) {
      const parsed = parseTokenPlanPointer(p);
      expect(tokenPlanPointer(parsed.kind, parsed.id)).toBe(p);
    }
  });
});

describe('selectScope', () => {
  const scopes = [
    { kind: 'me' as const, id: 'u1' },
    { kind: 'team' as const, id: 't1' },
    { kind: 'team' as const, id: 't2' },
    { kind: 'org' as const, id: 'o1' },
  ];

  it('picks by kind, the named team, or the first team', () => {
    expect(selectScope(scopes, { kind: 'me' })?.id).toBe('u1');
    expect(selectScope(scopes, { kind: 'org' })?.id).toBe('o1');
    expect(selectScope(scopes, { kind: 'team' })?.id).toBe('t1');
    expect(selectScope(scopes, { kind: 'team', id: 't2' })?.id).toBe('t2');
  });

  it('falls back to me when the pointer names a scope the user lacks', () => {
    expect(selectScope(scopes, { kind: 'team', id: 'nope' })?.id).toBe('u1');
    expect(selectScope([scopes[0]], { kind: 'org' })?.id).toBe('u1');
    expect(selectScope([], { kind: 'org' })).toBeUndefined();
  });
});

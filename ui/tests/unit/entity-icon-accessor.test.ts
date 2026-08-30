import { describe, it, expect } from 'vitest';
import { Organization } from '@sdk/entities/organization';
import { Team } from '@sdk/entities/team';
import { Group } from '@sdk/entities/group';
import { Prompt } from '@sdk/entities/prompt';
import { Capability } from '@sdk/entities/capability';

describe('APIEntity.icon accessor pair', () => {
  it('takes a per-row icon from the wire without throwing', () => {
    expect(new Organization({ name: 'o', icon: 'building' }).icon).toBe('building');
    expect(new Team({ name: 't', icon: 'users' } as never).icon).toBe('users');
    expect(new Group({ name: 'g', icon: 'folder' } as never).icon).toBe('folder');
    expect(new Prompt({ name: 'p', icon: 'star' } as never).icon).toBe('star');
  });
  it('falls back to the static type glyph, else null', () => {
    expect(new Capability({ kind: 'k' } as never).icon).toBe('BadgeCheck');
    expect(new Capability({ kind: 'k', icon: 'Custom' } as never).icon).toBe('Custom');
    expect(new Group({ name: 'g' } as never).icon).toBe(null);
    expect(new Prompt({ name: 'p' } as never).icon).toBe(null);
  });
  it('keeps icon own+enumerable so toJSON serializes it', () => {
    const g = new Group({ name: 'g', icon: 'folder' } as never);
    expect(Object.keys(g)).toContain('icon');
    expect(JSON.parse(JSON.stringify(g)).icon).toBe('folder');
  });
});

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
  it('serializes icon, which is a prototype accessor the own-property loop cannot see', () => {
    const g = new Group({ name: 'g', icon: 'folder' } as never);
    // Assert the REQUIREMENT (it reaches the wire), not the mechanism — this
    // used to be an own-property mirror installed per instance, and is now a
    // line in `toJSON`.
    expect(g.toJSON().icon).toBe('folder');
    expect(JSON.parse(JSON.stringify(g)).icon).toBe('folder');
  });

  it('does not let a subclass icon-like member collide with the base accessor', async () => {
    // `AgenticProcess` computes a vendor glyph KEY, deliberately not called
    // `icon` — the collision is what used to force a per-construction guard.
    const { AgenticProcess } = await import('@sdk/process/agentic-process');
    const p = new AgenticProcess({ worker_type: 'codex' } as never);
    expect(p.processIconKey).toBe('codex');
    expect(() => (p.icon = 'Something')).not.toThrow();
  });
});

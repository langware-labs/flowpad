import { describe, expect, it } from 'vitest';
import {
  deriveImproveStatus,
  improvableSkills,
  skillFileIsDirty,
} from '@src/components/terminal/interactive-terminal/side-windows/analysis-improvements';
import type { AgentTraceDoc } from '@src/components/assets/editor/agent-trace/trace-types';

/** Minimal trace doc with a by_skill map — only the shape the derivations read. */
function trace(bySkill: Record<string, { skill: string; findings: unknown[] }>): AgentTraceDoc {
  return { annotations: { by_skill: bySkill } } as unknown as AgentTraceDoc;
}

describe('improvableSkills', () => {
  it('returns only skills with at least one finding', () => {
    const doc = trace({
      'with-issues': { skill: 'with-issues', findings: [{ kind: 'issue', label: 'x' }] },
      clean: { skill: 'clean', findings: [] },
    });
    const out = improvableSkills(doc);
    expect(out.map((s) => s.skillName)).toEqual(['with-issues']);
    expect(out[0].findings).toHaveLength(1);
  });

  it('returns [] for a null doc or an analysis with no skill findings', () => {
    expect(improvableSkills(null)).toEqual([]);
    expect(improvableSkills(trace({}))).toEqual([]);
    expect(improvableSkills(trace({ a: { skill: 'a', findings: [] } }))).toEqual([]);
  });
});

describe('skillFileIsDirty', () => {
  const path = '/repo/.claude/skills/slick/SKILL.md';
  it('matches this skill’s own SKILL.md (repo-relative status path)', () => {
    expect(skillFileIsDirty([{ path: '.claude/skills/slick/SKILL.md' }], path)).toBe(true);
  });
  it('does NOT mark dirty when a DIFFERENT skill’s SKILL.md is the dirty one', () => {
    expect(skillFileIsDirty([{ path: '.claude/skills/agent-trace/SKILL.md' }], path)).toBe(false);
  });
  it('clean tree → not dirty', () => {
    expect(skillFileIsDirty([{ path: 'ui/src/foo.tsx' }], path)).toBe(false);
    expect(skillFileIsDirty([], path)).toBe(false);
  });
});

describe('deriveImproveStatus', () => {
  it('dirty working tree → done, regardless of run activity', () => {
    expect(deriveImproveStatus({ dirty: true, launched: false, anyRunning: false })).toBe('done');
    expect(deriveImproveStatus({ dirty: true, launched: true, anyRunning: true })).toBe('done');
  });

  it('launched + a run active (not dirty yet) → running', () => {
    expect(deriveImproveStatus({ dirty: false, launched: true, anyRunning: true })).toBe('running');
  });

  it('idle when nothing launched, or a launched run already ended without edits', () => {
    expect(deriveImproveStatus({ dirty: false, launched: false, anyRunning: true })).toBe('idle');
    expect(deriveImproveStatus({ dirty: false, launched: true, anyRunning: false })).toBe('idle');
  });
});

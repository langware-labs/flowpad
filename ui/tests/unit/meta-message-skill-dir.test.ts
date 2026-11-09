import { describe, expect, it } from 'vitest';

const { parseSkillDir } = await import('@src/components/entity-execution-panel/MetaMessageChip');

describe('parseSkillDir', () => {
  it('keeps a skill folder whose path has spaces (a box workspace is "Flowpad workspace")', () => {
    const content =
      'Base directory for this skill: /home/user/Flowpad workspace/ai-course-lesson-3/.claude/skills/html-builder\n\n# HTML Builder';
    expect(parseSkillDir(content)).toBe('/home/user/Flowpad workspace/ai-course-lesson-3/.claude/skills/html-builder');
  });

  it('reads a path without spaces as before', () => {
    expect(parseSkillDir('Base directory for this skill: /Users/a/skills/x\nbody')).toBe('/Users/a/skills/x');
  });
});

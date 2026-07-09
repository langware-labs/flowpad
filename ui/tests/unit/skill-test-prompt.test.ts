import { describe, expect, it } from 'vitest';
import { buildSkillTestPrompt, TESTABLE_TYPES } from '@src/components/conversation/asset-review/test-prompt';

// The skill is addressed by its frontmatter NAME (install put it on the worker's
// skill search path), not a filesystem path — see buildSkillTestPrompt.
const NAME = 'find-me-a-product';

/** Exact first-prompt wording of the "Run" session (user-specified). */
describe('buildSkillTestPrompt', () => {
  it('with a user prompt', () => {
    expect(buildSkillTestPrompt(NAME, 'summarize the repo')).toBe(
      `use the skill ${NAME} in order to:\nsummarize the repo`,
    );
  });

  it('without a prompt → run form', () => {
    expect(buildSkillTestPrompt(NAME)).toBe(`run the skill ${NAME}`);
    expect(buildSkillTestPrompt(NAME, null)).toBe(`run the skill ${NAME}`);
    expect(buildSkillTestPrompt(NAME, '')).toBe(`run the skill ${NAME}`);
  });

  it('whitespace-only prompt → run form; prompt is trimmed', () => {
    expect(buildSkillTestPrompt(NAME, '   \n\t ')).toBe(`run the skill ${NAME}`);
    expect(buildSkillTestPrompt(NAME, '  do X  ')).toBe(`use the skill ${NAME} in order to:\ndo X`);
  });

  it('Run is offered for skills', () => {
    expect(TESTABLE_TYPES.has('skill')).toBe(true);
    expect(TESTABLE_TYPES.has('markdown')).toBe(false);
  });
});

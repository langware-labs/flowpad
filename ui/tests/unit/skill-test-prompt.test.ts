import { describe, expect, it } from 'vitest';
import { buildSkillTestPrompt, TESTABLE_TYPES } from '@src/components/conversation/asset-review/test-prompt';

const PATH = '/Users/bob/.flow/instances/oss/records_data/flow_message/flow_message-@x/unpacked/attachment/skill-@y';

/** Exact first-prompt wording of the "Test it" session (user-specified). */
describe('buildSkillTestPrompt', () => {
  it('with a user prompt', () => {
    expect(buildSkillTestPrompt(PATH, 'summarize the repo')).toBe(
      `use the skill ${PATH} in order to:\nsummarize the repo`,
    );
  });

  it('without a prompt → run form', () => {
    expect(buildSkillTestPrompt(PATH)).toBe(`run the skill ${PATH}`);
    expect(buildSkillTestPrompt(PATH, null)).toBe(`run the skill ${PATH}`);
    expect(buildSkillTestPrompt(PATH, '')).toBe(`run the skill ${PATH}`);
  });

  it('whitespace-only prompt → run form; prompt is trimmed', () => {
    expect(buildSkillTestPrompt(PATH, '   \n\t ')).toBe(`run the skill ${PATH}`);
    expect(buildSkillTestPrompt(PATH, '  do X  ')).toBe(`use the skill ${PATH} in order to:\ndo X`);
  });

  it('Test it is offered for skills', () => {
    expect(TESTABLE_TYPES.has('skill')).toBe(true);
    expect(TESTABLE_TYPES.has('markdown')).toBe(false);
  });
});

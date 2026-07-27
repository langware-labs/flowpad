import { describe, expect, it } from 'vitest';
import {
  buildSkillTestPrompt,
  resolveRunProjectId,
  TESTABLE_TYPES,
} from '@src/components/conversation/asset-review/test-prompt';

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

describe('resolveRunProjectId', () => {
  const CONV = 'conv-proj';
  const ACTIVE = 'active-proj';

  it('installed project scope wins', () => {
    expect(resolveRunProjectId({ project_id: 'installed' }, CONV, ACTIVE)).toBe('installed');
  });

  it('else conversation project, else active', () => {
    expect(resolveRunProjectId({ project_id: null }, CONV, ACTIVE)).toBe(CONV);
    expect(resolveRunProjectId({ project_id: null }, null, ACTIVE)).toBe(ACTIVE);
  });

  it('none resolvable → null (caller prompts)', () => {
    expect(resolveRunProjectId({ project_id: null }, null, null)).toBeNull();
    // '' is the backend's cleared form — must fall through, not win.
    expect(resolveRunProjectId({ project_id: '' }, '', null)).toBeNull();
  });
});

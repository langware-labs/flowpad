import { describe, expect, it } from 'vitest';
import { splitGitBranch } from '@src/components/project-selector/git-url';

describe('splitGitBranch', () => {
  it.each([
    ['https://github.com/o/r.git', { url: 'https://github.com/o/r.git' }],
    ['https://github.com/o/r/tree/main', { url: 'https://github.com/o/r', branch: 'main' }],
    ['https://github.com/o/r/tree/feature/x-y/', { url: 'https://github.com/o/r', branch: 'feature/x-y' }],
    ['https://github.com/o/r.git#dev', { url: 'https://github.com/o/r.git', branch: 'dev' }],
    ['  git@github.com:o/r.git  ', { url: 'git@github.com:o/r.git' }],
  ])('%s', (pasted, expected) => {
    expect(splitGitBranch(pasted)).toEqual(expected);
  });
});

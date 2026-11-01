import { describe, it, expect } from 'vitest';
import { gitResolvePrompt } from '@src/lib/git-resolve-prompt';

describe('gitResolvePrompt — push and pull finish differently', () => {
  it('push: continues the rebase, then pushes', () => {
    const p = gitResolvePrompt('main');
    expect(p).toContain('one-click push');
    expect(p).toContain('git push origin main');
  });

  it('pull: continues the rebase and never pushes', () => {
    const p = gitResolvePrompt('main', 'pull');
    expect(p).toContain('one-click pull');
    expect(p).toContain('git rebase --continue');
    expect(p).toContain('Do NOT push');
    expect(p).not.toContain('git push origin');
  });

  it('cherry-pick: continues the pick, puts the stashed edits back, never pushes', () => {
    const p = gitResolvePrompt('main', 'cherry-pick');
    expect(p).toContain('cherry-pick');
    expect(p).toContain('git cherry-pick --continue');
    expect(p).toContain('git stash pop');
    expect(p).toContain('Do NOT push');
    expect(p).not.toContain('git rebase --continue');
  });
});

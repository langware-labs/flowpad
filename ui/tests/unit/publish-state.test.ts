import { describe, it, expect } from 'vitest';
import { ViewMode } from '@src/components/view-mode';
import { derivePublishState, gitOutcomeCopy, publishCopy, type PushKind } from '@src/lib/publish-state';

describe('derivePublishState', () => {
  it('no repo → hidden', () => {
    expect(derivePublishState({ hasRepo: false, unpushed: 0 }).state).toBe('no-repo');
  });

  it('clean + tracked → aligned, nothing to publish', () => {
    const s = derivePublishState({ hasRepo: true, unpushed: 0 });
    expect(s.state).toBe('aligned');
    expect(s.pendingCount).toBe(0);
  });

  it('unpushed commits → unpublished, with count', () => {
    const s = derivePublishState({ hasRepo: true, unpushed: 2 });
    expect(s.state).toBe('unpublished');
    expect(s.pendingCount).toBe(2);
  });

  it('no upstream + nothing pending → local-only', () => {
    expect(derivePublishState({ hasRepo: true, unpushed: 0, hasUpstream: false }).state).toBe('local-only');
  });

  it('footer scope: uncommitted counts toward pending', () => {
    const s = derivePublishState({ hasRepo: true, unpushed: 1, uncommitted: 3 });
    expect(s.state).toBe('unpublished');
    expect(s.pendingCount).toBe(4);
  });
});

describe('publishCopy — count is Advanced-only', () => {
  it('Standard hides the count', () => {
    expect(publishCopy('unpublished', ViewMode.Standard).showCount).toBe(false);
  });
  it('Advanced shows the count', () => {
    expect(publishCopy('unpublished', ViewMode.Advanced).showCount).toBe(true);
    expect(publishCopy('unpublished', ViewMode.Dev).showCount).toBe(true);
  });
  it('verb is always "Publish", never "Push"', () => {
    expect(publishCopy('unpublished', ViewMode.Standard).publishLabel).toBe('Publish');
  });
});

describe('gitOutcomeCopy push — Standard never leaks git jargon', () => {
  const GIT_TERMS = /\b(push|pushed|branch|commit|rebase|remote|upstream|git)\b/i;
  const KINDS: PushKind[] = [
    'pushed',
    'nothing',
    'conflict',
    'permission',
    'no_remote',
    'network',
    'no_repo',
    'generic',
  ];

  for (const kind of KINDS) {
    it(`Standard '${kind}' has no git terms`, () => {
      const c = gitOutcomeCopy('push', kind, ViewMode.Standard, { branch: 'main', message: 'fatal: non-fast-forward' });
      expect(`${c.title} ${c.message}`).not.toMatch(GIT_TERMS);
    });
  }

  it('permission/no_remote are distinct error states', () => {
    expect(gitOutcomeCopy('push', 'permission', ViewMode.Standard).title).toBe("Can't publish here");
    expect(gitOutcomeCopy('push', 'no_remote', ViewMode.Standard).title).toBe('Nowhere to publish yet');
  });

  it('pushed/nothing are successes', () => {
    expect(gitOutcomeCopy('push', 'pushed', ViewMode.Standard).level).toBe('success');
    expect(gitOutcomeCopy('push', 'nothing', ViewMode.Standard).level).toBe('success');
  });
});

describe('gitOutcomeCopy pull — Standard never leaks git jargon', () => {
  const GIT_TERMS = /\b(pull|pulled|branch|commit|rebase|remote|upstream|git)\b/i;
  const KINDS = ['pulled', 'nothing', 'conflict', 'permission', 'no_remote', 'network', 'no_repo', 'generic'] as const;

  for (const kind of KINDS) {
    it(`Standard '${kind}' has no git terms`, () => {
      const c = gitOutcomeCopy('pull', kind, ViewMode.Standard, { branch: 'main', message: 'fatal: could not read' });
      expect(`${c.title} ${c.message}`).not.toMatch(GIT_TERMS);
    });
  }

  it('pulled/nothing are successes, the rest errors', () => {
    expect(gitOutcomeCopy('pull', 'pulled', ViewMode.Standard).level).toBe('success');
    expect(gitOutcomeCopy('pull', 'nothing', ViewMode.Standard).level).toBe('success');
    expect(gitOutcomeCopy('pull', 'network', ViewMode.Standard).level).toBe('error');
  });
});

describe('gitOutcomeCopy conflict — one answer for both directions', () => {
  const MODES = [ViewMode.Vibe, ViewMode.Standard, ViewMode.Advanced, ViewMode.Dev];

  for (const mode of MODES) {
    it(`${mode}: push and pull say the same thing and both offer Resolve`, () => {
      const push = gitOutcomeCopy('push', 'conflict', mode, { message: 'Conflicted: a.md' });
      const pull = gitOutcomeCopy('pull', 'conflict', mode, { message: 'Conflicted: a.md' });
      expect(push).toEqual(pull);
      expect(push.resolvable).toBe(true);
      expect(push.level).toBe('error');
    });
  }

  it('nothing but a conflict offers Resolve', () => {
    for (const op of ['push', 'pull'] as const) {
      for (const kind of ['generic', 'network', 'permission', 'no_remote', 'no_repo'] as const) {
        expect(gitOutcomeCopy(op, kind, ViewMode.Standard).resolvable).toBe(false);
      }
    }
  });
});

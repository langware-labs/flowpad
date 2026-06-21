import { describe, it, expect } from 'vitest';
import { ViewMode } from '@src/components/view-mode';
import {
  derivePublishState,
  publishCopy,
  pushToastCopy,
  type PushKind,
} from '@src/lib/publish-state';

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

describe('pushToastCopy — Standard never leaks git jargon', () => {
  const GIT_TERMS = /\b(push|pushed|branch|commit|rebase|remote|upstream|git)\b/i;
  const KINDS: PushKind[] = ['pushed', 'nothing', 'conflict', 'permission', 'no_remote', 'network', 'no_repo', 'generic'];

  for (const kind of KINDS) {
    it(`Standard '${kind}' has no git terms`, () => {
      const c = pushToastCopy(kind, ViewMode.Standard, { branch: 'main', message: 'fatal: non-fast-forward' });
      expect(`${c.title} ${c.message}`).not.toMatch(GIT_TERMS);
    });
  }

  it('conflict: Standard not resolvable, Advanced resolvable', () => {
    expect(pushToastCopy('conflict', ViewMode.Standard).resolvable).toBe(false);
    expect(pushToastCopy('conflict', ViewMode.Advanced).resolvable).toBe(true);
  });

  it('permission/no_remote are distinct error states', () => {
    expect(pushToastCopy('permission', ViewMode.Standard).title).toBe("Can't publish here");
    expect(pushToastCopy('no_remote', ViewMode.Standard).title).toBe('Nowhere to publish yet');
  });

  it('pushed/nothing are successes', () => {
    expect(pushToastCopy('pushed', ViewMode.Standard).level).toBe('success');
    expect(pushToastCopy('nothing', ViewMode.Standard).level).toBe('success');
  });
});

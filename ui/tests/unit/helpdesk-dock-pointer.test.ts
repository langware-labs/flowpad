import { describe, expect, it } from 'vitest';
import { Project, ViewType } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';

// The portal is addressed by URL, and its article paths contain spaces and
// slashes. Both of the failures guarded here are silent: a mangled path renders
// an empty article, and a wrong `targetTypeId` produces an untitled,
// project-less tab rather than an error.

describe('DockPointer.forHelpdesk / parseHelpdeskPointer', () => {
  const PROJECT = '5bd7bbe6-3835-4aa9-ad94-bce42e05c15c';

  it('round-trips the portal root', () => {
    const dock = DockPointer.forHelpdesk(PROJECT);
    expect(dock.viewType).toBe(ViewType.HELPDESK);
    expect(DockPointer.parseHelpdeskPointer(dock.pointer)).toEqual({
      projectId: PROJECT,
      articlePath: null,
    });
  });

  it('round-trips an article path containing spaces and slashes', () => {
    // The real showcase repo has exactly this shape.
    const article = 'docs/Getting Started/Welcome.md';
    const dock = DockPointer.forHelpdesk(PROJECT, article);
    expect(DockPointer.parseHelpdeskPointer(dock.pointer)).toEqual({
      projectId: PROJECT,
      articlePath: article,
    });
  });

  it('survives a URL round trip, where segments are encoded individually', () => {
    const article = 'docs/Getting Started/Welcome.md';
    const url = DockPointer.forHelpdesk(PROJECT, article).toUrl();
    const parsed = DockPointer.fromUrl(url);
    expect(parsed.viewType).toBe(ViewType.HELPDESK);
    expect(DockPointer.parseHelpdeskPointer(parsed.pointer)).toEqual({
      projectId: PROJECT,
      articlePath: article,
    });
  });

  it('never throws on a malformed or hand-edited pointer', () => {
    for (const pointer of ['', '   ', 'x/article', 'x/article/', '/', 'x/notarticle/y']) {
      expect(() => DockPointer.parseHelpdeskPointer(pointer), pointer).not.toThrow();
    }
    // A dangling `article` marker yields no path rather than an empty one.
    expect(DockPointer.parseHelpdeskPointer(`${PROJECT}/article`).articlePath).toBeNull();
    // A non-`article` second segment is not an article.
    expect(DockPointer.parseHelpdeskPointer(`${PROJECT}/other/x`).articlePath).toBeNull();
  });
});

describe('DockPointer.targetTypeId for a helpdesk dock', () => {
  const PROJECT = '5bd7bbe6-3835-4aa9-ad94-bce42e05c15c';

  it('targets the portal PROJECT, not a bogus "helpdesk" entity', () => {
    // The generic fallback would mint TypeId('helpdesk', <id>), leaving the tab
    // untitled and Global-scoped — the same bug already documented for
    // LIVE_SESSION. This assertion is the guard.
    const target = DockPointer.forHelpdesk(PROJECT).targetTypeId;
    expect(target?.type).toBe(Project.type);
    expect(target?.id).toBe(PROJECT);
  });

  it('keeps targeting the project when an article is open', () => {
    // Articles are files, not entities: the tab must stay on the portal.
    const target = DockPointer.forHelpdesk(PROJECT, 'docs/Getting Started/Welcome.md').targetTypeId;
    expect(target?.type).toBe(Project.type);
    expect(target?.id).toBe(PROJECT);
  });

  it('yields no target for a project-less portal dock', () => {
    expect(DockPointer.forHelpdesk().targetTypeId).toBeNull();
  });
});

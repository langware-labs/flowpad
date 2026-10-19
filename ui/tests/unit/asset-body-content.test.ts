import { describe, expect, it } from 'vitest';
import { isProjectHomeSurface, shouldShowIndexPrompt } from '@src/components/assets/asset-body-content';

/**
 * Regression: clicking the rails project icon opened /dock/assets/project-home,
 * where the index status is read unscoped (global) — so on a never-indexed
 * instance `neverIndexed` was true and, in Advanced view, the Build Index
 * prompt hid project home entirely.
 *
 * The invariant: the index prompt never preempts the project-home landing.
 */
describe('shouldShowIndexPrompt', () => {
  it('never shows the prompt in project-home mode — the bug', () => {
    // The exact reproduced state: never-indexed, Advanced, project-home landing.
    // Project home must win; without the guard this returned true (Build Index).
    expect(
      shouldShowIndexPrompt({ neverIndexed: true, isAdvanced: true, isProjectHomeMode: true }),
    ).toBe(false);
  });

  it('shows the prompt while browsing assets when nothing is indexed (Advanced)', () => {
    expect(
      shouldShowIndexPrompt({ neverIndexed: true, isAdvanced: true, isProjectHomeMode: false }),
    ).toBe(true);
  });

  it('is Advanced-only — lower modes show their own surface, never the prompt', () => {
    expect(
      shouldShowIndexPrompt({ neverIndexed: true, isAdvanced: false, isProjectHomeMode: false }),
    ).toBe(false);
  });

  it('does not show the prompt once something is indexed', () => {
    expect(
      shouldShowIndexPrompt({ neverIndexed: false, isAdvanced: true, isProjectHomeMode: false }),
    ).toBe(false);
  });
});

/** The bare `/dock/assets?scope-mode=project&…` state — see the helper's own
 *  doc comment for why that URL gets minted constantly. */
describe('isProjectHomeSurface', () => {
  const P = 'c82a1115-2f20-52e0-aa2a-4658898b5873';

  it('treats a bare, project-scoped assets URL as the landing — the bug', () => {
    expect(isProjectHomeSurface({ isProjectView: false, pointer: '', scopedProjectId: P })).toBe(true);
    expect(isProjectHomeSurface({ isProjectView: false, pointer: undefined, scopedProjectId: P })).toBe(true);
  });

  it('still honours the explicit project-home sub-pointer', () => {
    expect(isProjectHomeSurface({ isProjectView: false, pointer: 'project-home', scopedProjectId: P })).toBe(true);
  });

  it('leaves addressed content alone', () => {
    for (const pointer of ['list/skill', 'editor/skill-1', 'folder/markdown/x/y', 'wiki/Home', 'fs/vfs/@local/x']) {
      expect(isProjectHomeSurface({ isProjectView: false, pointer, scopedProjectId: P })).toBe(false);
    }
  });

  it('needs a project: bare and unscoped stays a type picker', () => {
    expect(isProjectHomeSurface({ isProjectView: false, pointer: '', scopedProjectId: null })).toBe(false);
    expect(isProjectHomeSurface({ isProjectView: false, pointer: 'project-home', scopedProjectId: null })).toBe(false);
  });

  it('matches the project dock, whose empty sub-pointer always meant the landing', () => {
    expect(isProjectHomeSurface({ isProjectView: true, pointer: '', scopedProjectId: P })).toBe(true);
    expect(isProjectHomeSurface({ isProjectView: true, pointer: 'list/skill', scopedProjectId: P })).toBe(false);
    // `project-home` is assets-URL grammar; under /dock/project/<id> it would be
    // a sub-pointer naming nothing, not the landing.
    expect(isProjectHomeSurface({ isProjectView: true, pointer: 'project-home', scopedProjectId: P })).toBe(false);
  });
});

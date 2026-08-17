/**
 * Subprojects in the project-chip menu: a project whose folder lives inside
 * another project's folder is shown INDENTED under it. This is a pure display
 * grouping (no entity relationship). These tests pin the two pure seams:
 *   - `isPathInside` — the cross-platform containment test (Windows `\`,
 *     case-insensitive filesystems, and the `/foo/bar` vs `/foo/barn` boundary).
 *   - `buildProjectTreeRows` — parent→child render order + the tree-guide
 *     columns each row draws, including multi-level nesting.
 */
import { buildProjectTreeRows, isPathInside } from '@src/components/terminal/ProjectsCounterChip';
import type { TabProjectBucket } from '@src/tabs/use-tab-manager';
import type { Project } from '@sdk';
import { describe, expect, it } from 'vitest';

/** Minimal live/loading bucket. `null` path ⇒ unresolved (stays top-level). */
function bucket(name: string, path: string | null): TabProjectBucket {
  const project =
    path == null
      ? null
      : ({ fs_storage_mount_path: path, name, getDisplayName: () => name } as unknown as Project);
  return {
    projectId: name,
    project,
    state: path == null ? 'loading' : 'live',
    tabCount: 1,
    recover: () => Promise.resolve(null),
  };
}

const order = (rows: ReturnType<typeof buildProjectTreeRows>) => rows.map((r) => r.bucket.projectId);
const guidesOf = (rows: ReturnType<typeof buildProjectTreeRows>, id: string) =>
  rows.find((r) => r.bucket.projectId === id)!.guides;

describe('isPathInside — cross-platform containment', () => {
  it('normalizes Windows backslashes before comparing', () => {
    expect(isPathInside('C:\\work\\app\\ui', 'C:\\work\\app')).toBe(true);
  });

  it('is case-insensitive (safe for Windows/macOS filesystems)', () => {
    expect(isPathInside('/work/App/UI', '/WORK/app')).toBe(true);
  });

  it('respects the separator boundary — a name prefix is not containment', () => {
    expect(isPathInside('/foo/barn', '/foo/bar')).toBe(false);
  });

  it('tolerates trailing separators', () => {
    expect(isPathInside('/work/app/ui/', '/work/app/')).toBe(true);
  });

  it('a path is not inside itself, nor is a parent inside its child', () => {
    expect(isPathInside('/work/app', '/work/app')).toBe(false);
    expect(isPathInside('/work', '/work/app')).toBe(false);
  });
});

describe('buildProjectTreeRows — parent → subproject nesting', () => {
  it('nests subprojects under their parent and keeps siblings alphabetical', () => {
    const rows = buildProjectTreeRows([
      bucket('app', '/work/app'),
      bucket('ui', '/work/app/ui'),
      bucket('docs', '/work/app/docs'),
      bucket('other', '/work/other'),
    ]);
    // roots alphabetical (app, other); app's children alphabetical (docs, ui).
    expect(order(rows)).toEqual(['app', 'docs', 'ui', 'other']);
    expect(guidesOf(rows, 'app')).toEqual([]);
    expect(guidesOf(rows, 'docs')).toEqual(['elbow']); // not the last child
    expect(guidesOf(rows, 'ui')).toEqual(['elbow-last']); // last child
    expect(guidesOf(rows, 'other')).toEqual([]);
  });

  it('handles multi-level nesting with pass-through guide columns', () => {
    const rows = buildProjectTreeRows([
      bucket('app', '/work/app'),
      bucket('docs', '/work/app/docs'),
      bucket('ui', '/work/app/ui'),
      bucket('widget', '/work/app/ui/widget'),
    ]);
    expect(order(rows)).toEqual(['app', 'docs', 'ui', 'widget']);
    // ui is app's LAST child, so under it the ancestor column is blank.
    expect(guidesOf(rows, 'ui')).toEqual(['elbow-last']);
    expect(guidesOf(rows, 'widget')).toEqual(['blank', 'elbow-last']);
  });

  it('picks the DEEPEST enclosing project as the parent', () => {
    const rows = buildProjectTreeRows([
      bucket('app', '/work/app'),
      bucket('ui', '/work/app/ui'),
      bucket('widget', '/work/app/ui/widget'),
    ]);
    // widget nests under ui (deepest), not app.
    expect(order(rows)).toEqual(['app', 'ui', 'widget']);
    // depth 2: the app-level column is blank (ui is app's last child, so no
    // vertical continues there), then the elbow into widget.
    expect(guidesOf(rows, 'widget')).toEqual(['blank', 'elbow-last']);
  });

  it('keeps path-less (loading/missing) buckets at the top level', () => {
    const rows = buildProjectTreeRows([
      bucket('app', '/work/app'),
      bucket('ui', '/work/app/ui'),
      bucket('pending', null),
    ]);
    expect(guidesOf(rows, 'pending')).toEqual([]);
    expect(order(rows)).toEqual(['app', 'ui', 'pending']);
  });
});

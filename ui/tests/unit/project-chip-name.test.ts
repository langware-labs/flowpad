/**
 * Unit tests for `resolveProjectChipName` — the pure name-resolution behind the
 * tab-strip project chip. It shows the current project's name alongside the
 * open-projects/terminals counts: prefer the explicit prop, else fall back to
 * the matching open bucket's display name, else null (counts-only chip).
 */
import { describe, expect, it } from 'vitest';
import { resolveProjectChipName } from '@src/components/terminal/project-list-menu';
import type { TabProjectBucket } from '@src/tabs/use-tab-manager';

// Minimal bucket shapes — resolveProjectChipName only reads projectId + project.
const bucket = (projectId: string, name: string | null): TabProjectBucket =>
  ({
    projectId,
    project: name === null ? null : ({ displayName: name, name } as any),
    tabCount: 0,
    state: 'live',
  } as unknown as TabProjectBucket);

describe('resolveProjectChipName', () => {
  it('prefers the explicit current-project name', () => {
    expect(resolveProjectChipName('My Project', 'p1', [bucket('p1', 'Bucket Name')])).toBe('My Project');
  });

  it('trims the explicit name', () => {
    expect(resolveProjectChipName('  Spaced  ', null, [])).toBe('Spaced');
  });

  it('falls back to the matching open bucket when no explicit name', () => {
    const buckets = [bucket('p1', 'Alpha'), bucket('p2', 'Beta')];
    expect(resolveProjectChipName(null, 'p2', buckets)).toBe('Beta');
  });

  it('uses the bucket display name over the raw id', () => {
    expect(resolveProjectChipName('', 'p9', [bucket('p9', 'Pretty Name')])).toBe('Pretty Name');
  });

  it('falls back to the projectId when the bucket has no project entity', () => {
    expect(resolveProjectChipName(undefined, 'p3', [bucket('p3', null)])).toBe('p3');
  });

  it('returns null when no name and no matching bucket (counts-only chip)', () => {
    expect(resolveProjectChipName(null, 'missing', [bucket('p1', 'Alpha')])).toBeNull();
    expect(resolveProjectChipName(null, null, [])).toBeNull();
    expect(resolveProjectChipName('   ', null, [])).toBeNull(); // blank name is not a name
  });
});

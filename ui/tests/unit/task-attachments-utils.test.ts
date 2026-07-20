import { describe, expect, it } from 'vitest';
import type { GitOrigin } from '@sdk';
import { gitOriginKey } from '@src/utils/gitUtils';
import {
  attachmentKey,
  makeAttachmentEntry,
  normalizeAttachments,
} from '@src/components/assets/editor/task/task-attachments-utils';

const ORIGIN: GitOrigin = {
  kind: 'git',
  provider: 'github',
  owner: 'acme',
  name: 'repo',
  branch: 'main',
  rel_path: '',
} as GitOrigin;

// ---------- normalizeAttachments ----------

describe('normalizeAttachments', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeAttachments(null)).toEqual([]);
    expect(normalizeAttachments(undefined)).toEqual([]);
    expect(normalizeAttachments({})).toEqual([]);
  });

  it('maps a string entry to {path,label}', () => {
    expect(normalizeAttachments(['/a/b/report.md'])).toEqual([{ path: '/a/b/report.md', label: 'report.md' }]);
  });

  it('keeps path for a NON-git object entry', () => {
    const out = normalizeAttachments([{ path: '/a/file.txt', label: 'file.txt' }]);
    expect(out).toEqual([{ path: '/a/file.txt', label: 'file.txt' }]);
  });

  it('DROPS the sender path for a git entry (identity is git_origin) and keeps rel', () => {
    const out = normalizeAttachments([
      { path: '/sender/machine/repo/pkg', label: 'pkg', git_origin: ORIGIN, rel: 'pkg' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ label: 'pkg', git_origin: ORIGIN, rel: 'pkg' });
    expect(out[0].path).toBeUndefined();
  });

  it('renders a git entry that has NO path (post-clean shape)', () => {
    const out = normalizeAttachments([{ label: 'repo', git_origin: ORIGIN }]);
    expect(out).toEqual([{ label: 'repo', git_origin: ORIGIN }]);
  });

  it('falls back to the repo name for a git entry with no label', () => {
    const out = normalizeAttachments([{ git_origin: ORIGIN }]);
    expect(out).toHaveLength(1);
    expect(out[0].git_origin).toEqual(ORIGIN);
    expect(out[0].label).toBeTruthy(); // gitOriginRepoFullName(ORIGIN)
  });

  it('drops an entry with neither path nor git_origin', () => {
    expect(normalizeAttachments([{ label: 'orphan' }])).toEqual([]);
  });
});

// ---------- attachmentKey ----------

describe('attachmentKey', () => {
  it('keys a git entry on its origin identity, never the path', () => {
    expect(attachmentKey({ label: 'x', git_origin: ORIGIN, path: '/sender/x' })).toBe(gitOriginKey(ORIGIN));
  });

  it('keys a non-git entry on its path', () => {
    expect(attachmentKey({ path: '/a/b.txt', label: 'b.txt' })).toBe('/a/b.txt');
  });
});

// ---------- makeAttachmentEntry ----------

describe('makeAttachmentEntry', () => {
  it('builds a git entry with a rel offset within its context folder, no path', () => {
    const entry = makeAttachmentEntry('/local/checkout/repo/sub/dir', ORIGIN, '/local/checkout/repo');
    expect(entry).toEqual({ label: 'dir', git_origin: ORIGIN, rel: 'sub/dir' });
    expect(entry.path).toBeUndefined();
  });

  it('omits rel when the attached path IS the context folder root', () => {
    const entry = makeAttachmentEntry('/local/checkout/repo', ORIGIN, '/local/checkout/repo');
    expect(entry).toEqual({ label: 'repo', git_origin: ORIGIN });
    expect(entry.rel).toBeUndefined();
  });

  it('omits rel when no context dir is known', () => {
    const entry = makeAttachmentEntry('/x/y', ORIGIN, null);
    expect(entry).toEqual({ label: 'y', git_origin: ORIGIN });
  });

  it('keeps path for a non-git entry', () => {
    expect(makeAttachmentEntry('/a/b.txt', undefined, null)).toEqual({ path: '/a/b.txt', label: 'b.txt' });
  });
});

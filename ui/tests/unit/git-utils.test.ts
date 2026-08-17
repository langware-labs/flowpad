import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { GitOrigin } from '@sdk';

// Mock only Folder.getById + TypeId (identity passthrough); everything else in
// @sdk stays real.
const { mockGetById } = vi.hoisted(() => ({ mockGetById: vi.fn() }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  Folder: { getById: mockGetById },
  TypeId: class {
    id: string;
    constructor(s: string) {
      this.id = s;
    }
  },
}));

import { gitOriginKey, resolveLocalGitRoot } from '@src/utils/gitUtils';

const origin = (over: Partial<GitOrigin> = {}): GitOrigin =>
  ({
    kind: 'git',
    provider: 'github',
    owner: 'acme',
    name: 'repo',
    branch: 'main',
    rel_path: '',
    ...over,
  }) as GitOrigin;

beforeEach(() => vi.clearAllMocks());

// ---------- gitOriginKey ----------

describe('gitOriginKey', () => {
  it('is stable and machine-independent for a complete origin', () => {
    expect(gitOriginKey(origin())).toBe(gitOriginKey(origin()));
    expect(gitOriginKey(origin())).toContain('acme/repo');
  });

  it('returns null for an incomplete origin', () => {
    expect(gitOriginKey(null)).toBeNull();
    expect(gitOriginKey(origin({ owner: '' }))).toBeNull();
    expect(gitOriginKey(origin({ name: '' }))).toBeNull();
  });

  it('normalizes rel_path "." to empty (same key as no rel_path)', () => {
    expect(gitOriginKey(origin({ rel_path: '.' }))).toBe(gitOriginKey(origin({ rel_path: '' })));
  });

  it('case-folds and strips a .git suffix (mirrors the backend repo key)', () => {
    expect(gitOriginKey(origin({ owner: 'ACME', name: 'Repo.git', provider: 'GitHub' }))).toBe(gitOriginKey(origin()));
  });

  it('is branch- and commit-INDEPENDENT — the same repo+subpath is one identity', () => {
    // Two local clones of the same repo (different branch / pinned commit) must
    // reconcile to the SAME key, matching the system’s branch-independent
    // Folder identity. Otherwise the same repo would look like two folders.
    expect(gitOriginKey(origin({ branch: 'dev' }))).toBe(gitOriginKey(origin({ branch: 'main' })));
    expect(gitOriginKey(origin({ head_commit: 'abc123' } as never))).toBe(gitOriginKey(origin()));
  });

  it('DOES distinguish a different subpath in the same repo', () => {
    expect(gitOriginKey(origin({ rel_path: 'pkg' }))).not.toBe(gitOriginKey(origin({ rel_path: '' })));
  });
});

// ---------- resolveLocalGitRoot ----------

describe('resolveLocalGitRoot', () => {
  it('returns the local path of the context folder whose origin matches', async () => {
    mockGetById.mockImplementation((id: string) =>
      id === 'other' ? { origin: origin({ name: 'elsewhere' }) } : { origin: origin() },
    );
    const dirs = [
      { path: '/home/me/other/', typeid: 'other' },
      { path: '/home/me/repo/', typeid: 'match' },
    ];
    const root = await resolveLocalGitRoot(origin(), dirs);
    expect(root).toBe('/home/me/repo'); // trailing slash stripped, THIS machine's path
  });

  it('matches a local checkout of the same repo+subpath on a DIFFERENT branch', async () => {
    // The recipient cloned `dev`; the attachment origin says `main`. Identity is
    // branch-independent, so it still resolves to this checkout (not a re-pull).
    mockGetById.mockResolvedValue({ origin: origin({ branch: 'dev' }) });
    const root = await resolveLocalGitRoot(origin({ branch: 'main' }), [{ path: '/home/me/repo/', typeid: 't' }]);
    expect(root).toBe('/home/me/repo');
  });

  it('returns null when no local checkout matches the origin', async () => {
    mockGetById.mockResolvedValue({ origin: origin({ name: 'different' }) });
    const root = await resolveLocalGitRoot(origin(), [{ path: '/home/me/x/', typeid: 't' }]);
    expect(root).toBeNull();
  });

  it('returns null for empty context dirs', async () => {
    expect(await resolveLocalGitRoot(origin(), [])).toBeNull();
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it('skips folders that fail to load and keeps matching', async () => {
    mockGetById.mockImplementation((id: string) => {
      if (id === 'boom') throw new Error('unreadable');
      return { origin: origin() };
    });
    const dirs = [
      { path: '/home/me/boom/', typeid: 'boom' },
      { path: '/home/me/repo/', typeid: 'ok' },
    ];
    expect(await resolveLocalGitRoot(origin(), dirs)).toBe('/home/me/repo');
  });
});

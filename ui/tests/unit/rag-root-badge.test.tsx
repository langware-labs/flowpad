/**
 * The brain marker on a folder row.
 *
 * Two properties, and the second is the one that bit.
 *
 * It is NARROW: only the paths a person added as roots wear it, never the descendants those
 * roots pull in. The marker says "coverage was chosen here"; branding a whole subtree would
 * make it say something vaguer and fill the tree with it.
 *
 * It is read at RENDER time, not when the row is built. Tree rows are built once and cached by
 * node id, and the roots arrive from a query a beat after the tree has already expanded — so a
 * `Set` captured at build time is frozen at "no roots yet" for every row listed before the
 * query landed. That is exactly what happened in the browser: the query returned the root, and
 * not one row wore the badge.
 *
 * The comparison is `machinePath` against the stored root. `absVfsPath` carries the
 * `<typeid>/` prefix and would never match, silently leaving every row plain.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { TypeId } from '@sdk';
import { allScope } from '@src/lib/scope-filter';

const { listDirectory, invalidate, ragRoots } = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  invalidate: vi.fn(),
  ragRoots: vi.fn(),
}));

vi.mock('@sdk', async () => {
  const actual = await vi.importActual<typeof import('@sdk')>('@sdk');
  return { ...actual, fsStore: { getState: () => ({ listDirectory, invalidate }) } };
});

// The provider's own query needs a live backend; the marker's logic does not. Stub at the
// context read so the rows under test are the real ones.
vi.mock('@src/hooks/use-rag-roots', async () => {
  const actual = await vi.importActual<typeof import('@src/hooks/use-rag-roots')>(
    '@src/hooks/use-rag-roots',
  );
  return { ...actual, useRagRoots: ragRoots };
});

const { fsFolderNode } = await import('@src/components/browseable-tree/adapters/fsFolderRoot');
const { assetContextFoldersRoot } = await import(
  '@src/components/browseable-tree/adapters/assetContextFoldersRoot'
);

const CN = new TypeId('compute_node', '@local');
const DOCS = '/Users/alice/ws/repo/docs';
const SRC = '/Users/alice/ws/repo/src';

beforeEach(() => {
  ragRoots.mockReturnValue(new Set<string>());
});

/** Render a row's glyph with *roots* in scope and look for the brain. */
function hasBrain(icon: unknown, roots: Set<string> = new Set([DOCS])): boolean {
  ragRoots.mockReturnValue(roots);
  const { container, unmount } = render(icon as ReactElement);
  const found = !!container.querySelector('[data-testid="rag-root-badge"]');
  unmount();
  return found;
}

describe('a filesystem folder row', () => {
  it('wears the brain when its machine path is an index root', () => {
    expect(hasBrain(fsFolderNode(CN, allScope(), DOCS).icon)).toBe(true);
  });

  it('stays a plain folder when it is not', () => {
    expect(hasBrain(fsFolderNode(CN, allScope(), SRC).icon)).toBe(false);
  });

  it('does not mark a descendant of a root', () => {
    expect(hasBrain(fsFolderNode(CN, allScope(), `${DOCS}/guides`).icon)).toBe(false);
  });

  it('is plain when no index exists at all', () => {
    expect(hasBrain(fsFolderNode(CN, allScope(), DOCS).icon, new Set())).toBe(false);
  });
});

describe('the marker is read when the row renders, not when it is built', () => {
  it('appears on a row that was built before the query returned', () => {
    // The regression, exactly: the tree expands, THEN the roots arrive.
    ragRoots.mockReturnValue(new Set<string>());
    const row = fsFolderNode(CN, allScope(), DOCS);
    expect(hasBrain(row.icon, new Set([DOCS]))).toBe(true);
  });

  it('goes away on that same row once the root is removed', () => {
    const row = fsFolderNode(CN, allScope(), DOCS);
    expect(hasBrain(row.icon, new Set([DOCS]))).toBe(true);
    expect(hasBrain(row.icon, new Set())).toBe(false);
  });
});

describe('a context-folder row', () => {
  async function firstRow() {
    const root = assetContextFoldersRoot({
      dirs: [{ path: DOCS, origin_kind: 'local' }],
      fsTypeId: CN,
      fsLocatorTypeId: CN,
      projectId: null,
    });
    return (await root.listChildren!())[0];
  }

  it('wears the brain on the root it covers', async () => {
    expect(hasBrain((await firstRow()).icon)).toBe(true);
  });

  it('is plain otherwise', async () => {
    expect(hasBrain((await firstRow()).icon, new Set([SRC]))).toBe(false);
  });
});

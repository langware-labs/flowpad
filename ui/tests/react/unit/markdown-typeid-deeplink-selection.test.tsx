/**
 * RCA capture + fix: a markdown doc opened by its TYPEID URL must auto-expand +
 * select in the Assets folder tree — like the vfs deep-link already does.
 *
 * Proven root cause (this session): the editor opens markdown via the typeid
 * pointer form (`editor/markdown/typeid/markdown-<uuid>`), but the markdown
 * folder tree is vfs-keyed. `useAssetsModel` handed the tree that very typeid
 * pointer as `treeActivePointer`, and `markdownFolderRoot.pathFor` only resolves
 * the *vfs* form (`parseAssetPointer` returns `vfsPath = null` for a typeid), so
 * it returned `[root]` — the folder never auto-expanded and the leaf never
 * matched. Observed live: typeid URL → ariaSelected:[]; same doc via vfs URL →
 * ariaSelected:["arch_high_level.md"].
 *
 * Fix: `useAssetsModel` already resolves the open entity (`useEntity`), which
 * carries its vfs `asset_ref`. It preserves the real TypeId URL as the tree's
 * navigation cursor and exposes a second resource pointer for VFS path
 * resolution + selection. No id re-minting, no adapter change.
 *
 * Two faithful, self-contained checks (real components; only the `/assets/*`
 * HTTP boundary / peripheral hooks are staged, never the unit under test):
 *   1. HOST (the fix): `useAssetsModel` preserves the typeid URL and derives a
 *      separate vfs resource pointer once the entity resolves. `useEntity` is
 *      REAL, reading a cache-seeded entity.
 *   2. TREE (the downstream contract the fix relies on): given the TypeId URL
 *      plus its resolved VFS resource pointer, the real `BrowseableTree` +
 *      `markdownFolderRoot` auto-expand + `aria-selected` the leaf.
 */
import { dataManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@sdk/client';
import { BrowseableTree } from '@src/components/browseable-tree';
import {
  markdownFolderRoot,
  __resetVaultFilesCacheForTests,
} from '@src/components/browseable-tree/adapters/markdownFolderRoot';
import type { AssetTypeInfo, AssetTypeVault } from '@src/hooks/use-asset-types';

// The real vault root + doc from the report. (path → typeid) is the genuine
// observed pair; markdown ids are uuid5 of the vfs path.
const PROJECT_ID = '72fac107-c8df-5ab0-8cd1-54edb97bbe71';
const VAULT_ABS = '/Users/shlom/Flowpad workspace/sapora-streams';
const DOC_REL = 'docs/arch_high_level.md';
const DOC_ABS = `${VAULT_ABS}/${DOC_REL}`;
const DOC_LEAF = 'arch_high_level.md';
const DOC_TYPEID = 'markdown-45eea0e2-3f5b-5e21-b587-b469dfc4c4cf';

const VAULT: AssetTypeVault = {
  typeid: 'compute_node-@local',
  relPath: VAULT_ABS.replace(/^\/+/, ''),
  absPath: VAULT_ABS,
  label: 'Project docs (sapora-streams)',
  scope: 'user', // only so the default asset filter renders it; scope is irrelevant here
  project_id: null,
};

function makeType(vaults: AssetTypeVault[]): AssetTypeInfo {
  return { type_name: 'markdown', label: 'Markdown', icon: 'BookOpen', vaults };
}

// ---- HOST test: the fix lives in useAssetsModel.treeActivePointer ----

// The editor URL: a PROJECT-view dock addressing the doc by its typeid.
const DOCK = new DockPointer(ViewType.PROJECT, `${PROJECT_ID}/editor/markdown/typeid/${DOC_TYPEID}`);
const nav = { openDock: vi.fn(), openTab: vi.fn() };
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => DOCK,
  useDockNavigation: () => ({ navigation: nav, currentDock: DOCK, isDockUrl: true, windowMode: false }),
}));
// Peripheral hooks — irrelevant to the pointer derivation under test.
vi.mock('@src/hooks/use-asset-types', () => ({ useAssetTypes: () => ({ types: [], isLoading: false }) }));
vi.mock('@src/hooks/use-asset-stats', () => ({
  useAssetStats: () => ({ stats: { per_type: {}, total: 0 }, isLoading: false }),
}));
vi.mock('@src/hooks/use-system-tools', () => ({
  useSystemTools: () => ({ indexType: vi.fn(), indexTypes: vi.fn() }),
}));

import { useAssetsModel } from '@src/components/assets/useAssetsModel';

describe('markdown typeid deep-link selection (RCA + fix)', () => {
  beforeEach(() => {
    __resetVaultFilesCacheForTests();
  });
  afterEach(async () => {
    cleanup();
    await dataManager.clearCache();
    vi.restoreAllMocks();
    nav.openDock.mockClear();
  });

  it('HOST: useAssetsModel keeps the typeid URL and resolves the doc vfs resource pointer', async () => {
    // The open entity carries its vfs asset_ref — seed it so the REAL useEntity
    // resolves it from cache (no backend round-trip).
    dataManager.updateEntityFromJson({
      type: 'markdown',
      id: '45eea0e2-3f5b-5e21-b587-b469dfc4c4cf',
      asset_ref: DOC_ABS,
      project_id: PROJECT_ID,
      name: DOC_LEAF,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAssetsModel(), { wrapper: Wrapper });

    // URL identity stays canonical; the separate resource cursor gives the
    // filesystem-backed tree the VFS identity it can resolve.
    const expected = DockPointer.forAssetEditor('markdown', DOC_ABS).pointer;
    await waitFor(() => {
      expect(result.current.treeActivePointer).toBe(DOCK);
      expect(result.current.treeActiveResourcePointer?.pointer).toBe(expected);
    });
  });

  it('TREE: a typeid URL plus vfs resource pointer expands + selects the doc leaf', async () => {
    const spy = vi.fn(() => Promise.resolve({ files: [DOC_REL] }));
    vi.spyOn(apiClient, 'get').mockImplementation(spy as never);

    const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
    const ptr = DockPointer.forAssetEditor('markdown', DOC_ABS);
    render(<BrowseableTree roots={[root]} activePointer={DOCK} activeResourcePointer={ptr} />);

    await waitFor(() => expect(screen.getByText(DOC_LEAF)).toBeInTheDocument());
    const leaf = screen.getByText(DOC_LEAF).closest('[role="treeitem"]');
    expect(leaf).toHaveAttribute('aria-selected', 'true');
  });
});

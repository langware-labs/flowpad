import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import apiClient from '@sdk/client';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { BrowseableTree } from '@src/components/browseable-tree';
import {
  markdownFolderRoot,
  __resetVaultFilesCacheForTests,
} from '@src/components/browseable-tree/adapters/markdownFolderRoot';
import type { AssetTypeInfo, AssetTypeVault } from '@src/hooks/use-asset-types';

// ---------- markdown-files walk mock ----------
//
// The adapter no longer lists per-folder via fsStore.listDirectory. It fetches
// the COMPLETE gitignore-aware walk of a vault once via
// `apiClient.get('/assets/markdown-files?root=…')` and derives folders/files
// in-memory. The endpoint returns vault-root-relative POSIX paths and is
// markdown-only (non-.md files are filtered server-side), so tests stage a flat
// list of .md paths; folders are inferred from path segments.

function stageVaultFiles(files: string[]) {
  // Resolve every markdown-files request to the same staged walk. The single
  // VAULT fixture means root never varies across one test.
  const spy = vi.fn(async (_path: string) => ({ files }));
  vi.spyOn(apiClient, 'get').mockImplementation(spy as never);
  return spy;
}

// ---------- fixtures ----------

function makeType(vaults: AssetTypeVault[]): AssetTypeInfo {
  return {
    type_name: 'markdown',
    label: 'Markdown',
    icon: 'BookOpen',
    vaults,
  };
}

const VAULT: AssetTypeVault = {
  typeid: 'compute_node-@local',
  relPath: 'Users/alice/docs',
  absPath: '/Users/alice/docs',
  label: 'User docs',
  scope: 'user',
  project_id: null,
};

function chevronTestId(node: { id: string }): string {
  return `browseable-chevron-${node.id}`;
}

describe('markdownFolderRoot adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // The walk is memoised per vault root at module scope; clear it so each
    // case re-fetches against its own staged file list.
    __resetVaultFilesCacheForTests();
  });

  describe('vault enumeration', () => {
    it('lists vaults as children of the Markdown root', async () => {
      stageVaultFiles([]);
      const user = userEvent.setup();
      const root = markdownFolderRoot(makeType([VAULT]), {
        indexType: vi.fn(async () => ({ indexed: 0 })),
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);

      // Expand the Markdown root
      await user.click(screen.getByTestId(chevronTestId(root)));
      await waitFor(() => expect(screen.getByText('User docs')).toBeInTheDocument());
    });

    it('markdown root without vaults renders with no children', async () => {
      stageVaultFiles([]);
      const user = userEvent.setup();
      const root = markdownFolderRoot(makeType([]), {
        indexType: vi.fn(async () => ({ indexed: 0 })),
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      // The root has hasChildren = (vaults.length > 0) → false when empty
      expect(screen.queryByTestId(chevronTestId(root))).not.toBeInTheDocument();
    });
  });

  describe('folder expansion + listChildren', () => {
    it('expanding a vault fetches the markdown walk and renders files/folders', async () => {
      // `architecture/` is INFERRED from the path segment of a file beneath it.
      const spy = stageVaultFiles(['architecture/intro.md', 'readme.md']);
      const user = userEvent.setup();
      const root = markdownFolderRoot(makeType([VAULT]), {
        indexType: vi.fn(async () => ({ indexed: 0 })),
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);

      await user.click(screen.getByTestId(chevronTestId(root)));
      await waitFor(() => expect(screen.getByText('User docs')).toBeInTheDocument());
      await user.click(screen.getByTestId('browseable-chevron-md-folder:compute_node-@local:/Users/alice/docs'));

      await waitFor(() => {
        expect(screen.getByText('architecture')).toBeInTheDocument();
        expect(screen.getByText('readme.md')).toBeInTheDocument();
      });

      expect(spy).toHaveBeenCalled();
    });

    it('renders only the markdown walk (non-.md filtered server-side)', async () => {
      // The /assets/markdown-files endpoint is markdown-only, so a non-.md file
      // like image.png never reaches the client. `subdir/` is inferred from a
      // file beneath it.
      stageVaultFiles(['README.md', 'note.md', 'subdir/guide.md']);
      const user = userEvent.setup();
      const root = markdownFolderRoot(makeType([VAULT]), {
        indexType: vi.fn(),
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      await user.click(screen.getByTestId(chevronTestId(root)));
      await waitFor(() => screen.getByText('User docs'));
      await user.click(screen.getByTestId('browseable-chevron-md-folder:compute_node-@local:/Users/alice/docs'));

      await waitFor(() => {
        expect(screen.getByText('README.md')).toBeInTheDocument();
        expect(screen.getByText('note.md')).toBeInTheDocument();
        expect(screen.getByText('subdir')).toBeInTheDocument();
        expect(screen.queryByText('image.png')).not.toBeInTheDocument();
      });
    });

    it('sorts folders first then files alphabetically', async () => {
      // alpha/ and beta/ are inferred from files beneath them.
      stageVaultFiles(['zeta.md', 'alpha/a.md', 'alpha.md', 'beta/b.md']);
      const user = userEvent.setup();
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      await user.click(screen.getByTestId(chevronTestId(root)));
      await waitFor(() => screen.getByText('User docs'));
      await user.click(screen.getByTestId('browseable-chevron-md-folder:compute_node-@local:/Users/alice/docs'));

      await waitFor(() => screen.getByText('zeta.md'));

      // Locate the vault's children container by reading the rendered
      // treeitems in document order.
      const labels = Array.from(document.querySelectorAll('[role="treeitem"]'))
        .map((el) => (el.getAttribute('aria-level') === '3' ? el.textContent?.trim() ?? '' : null))
        .filter((x): x is string => x !== null);
      // Folders first (alpha, beta), then files (alpha.md, zeta.md)
      const folderIndexes = ['alpha', 'beta'].map((n) =>
        labels.findIndex((l) => l.startsWith(n) && !l.endsWith('.md')),
      );
      const fileIndexes = ['alpha.md', 'zeta.md'].map((n) =>
        labels.findIndex((l) => l.startsWith(n)),
      );
      for (const fi of folderIndexes) {
        for (const ff of fileIndexes) {
          expect(fi).toBeLessThan(ff);
        }
      }
    });

    it('shows empty state when a folder has no matching children', async () => {
      stageVaultFiles([]);
      const user = userEvent.setup();
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      await user.click(screen.getByTestId(chevronTestId(root)));
      await waitFor(() => screen.getByText('User docs'));
      await user.click(screen.getByTestId('browseable-chevron-md-folder:compute_node-@local:/Users/alice/docs'));
      await waitFor(() => expect(screen.getByText('Empty')).toBeInTheDocument());
    });
  });

  describe('click → navigation', () => {
    it('clicking a folder navigates with forAssetFolder pointer', async () => {
      stageVaultFiles(['architecture/intro.md']);
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      render(<BrowseableTree roots={[root]} activePointer={null} onNavigate={onNavigate} />);
      await user.click(screen.getByTestId(chevronTestId(root)));
      await waitFor(() => screen.getByText('User docs'));
      // Click the vault row text
      await user.click(screen.getByText('User docs'));
      const calls = onNavigate.mock.calls.map((c) => (c[0] as DockPointer).pointer);
      expect(calls).toContain('folder/markdown/compute_node-@local/Users/alice/docs');
    });

    it('clicking a .md file navigates with forAssetEditor pointer', async () => {
      stageVaultFiles(['readme.md']);
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      render(<BrowseableTree roots={[root]} activePointer={null} onNavigate={onNavigate} />);
      await user.click(screen.getByTestId(chevronTestId(root)));
      await waitFor(() => screen.getByText('User docs'));
      await user.click(screen.getByTestId('browseable-chevron-md-folder:compute_node-@local:/Users/alice/docs'));
      await waitFor(() => screen.getByText('readme.md'));

      await user.click(screen.getByText('readme.md'));
      const editorCall = onNavigate.mock.calls
        .map((c) => (c[0] as DockPointer).pointer)
        .find((p) => p?.startsWith('editor/markdown'));
      // Canonical AssetDocPointer grammar: editor/<editor>/vfs/<typeid>/<relPath>.
      // Build via the same factory the adapter uses so the assertion tracks
      // the grammar instead of hardcoding it.
      expect(editorCall).toBe(
        DockPointer.forAssetEditor('markdown', '/Users/alice/docs/readme.md').pointer,
      );
    });
  });

  describe('deep-link auto-expand', () => {
    it('activePointer = editor/markdown/<abs> auto-expands vault + intermediate folders + leaf', async () => {
      stageVaultFiles(['architecture/backend.md']);
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      // Canonical grammar via the factory (editor/<editor>/vfs/<typeid>/<relPath>).
      const deepPointer = DockPointer.forAssetEditor(
        'markdown',
        '/Users/alice/docs/architecture/backend.md',
      );
      render(<BrowseableTree roots={[root]} activePointer={deepPointer} />);

      await waitFor(() => {
        expect(screen.getByText('User docs')).toBeInTheDocument();
        expect(screen.getByText('architecture')).toBeInTheDocument();
        expect(screen.getByText('backend.md')).toBeInTheDocument();
      });

      const leaf = screen.getByText('backend.md').closest('[role="treeitem"]');
      expect(leaf).toHaveAttribute('aria-selected', 'true');
    });

    it('activePointer = folder/markdown/<typeid>/<rel> auto-expands to that folder', async () => {
      stageVaultFiles(['architecture/intro.md']);
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      const ptr = new DockPointer(
        ViewType.ASSETS,
        'folder/markdown/compute_node-@local/Users/alice/docs/architecture',
      );
      render(<BrowseableTree roots={[root]} activePointer={ptr} />);

      await waitFor(() => {
        expect(screen.getByText('User docs')).toBeInTheDocument();
        expect(screen.getByText('architecture')).toBeInTheDocument();
      });
      const archRow = screen.getByText('architecture').closest('[role="treeitem"]');
      expect(archRow).toHaveAttribute('aria-selected', 'true');
    });

    it('activePointer = folder/markdown/<typeid>/<vaultRel> auto-expands the vault folder itself and reveals its children', async () => {
      // Deep-link targets the vault root (the folder pointer equals the vault's relPath).
      // Expectation: the vault row is marked aria-expanded="true" and its
      // children (subfolders + .md files) render at aria-level=3.
      stageVaultFiles(['architecture/intro.md', 'readme.md']);
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      const ptr = new DockPointer(
        ViewType.ASSETS,
        'folder/markdown/compute_node-@local/Users/alice/docs',
      );
      render(<BrowseableTree roots={[root]} activePointer={ptr} />);

      await waitFor(() => {
        expect(screen.getByText('User docs')).toBeInTheDocument();
        expect(screen.getByText('architecture')).toBeInTheDocument();
        expect(screen.getByText('readme.md')).toBeInTheDocument();
      });

      const vaultRow = screen.getByText('User docs').closest('[role="treeitem"]');
      expect(vaultRow).toHaveAttribute('aria-selected', 'true');
      expect(vaultRow).toHaveAttribute('aria-expanded', 'true');

      // Children render one level deeper (root=1, vault=2, children=3).
      const archRow = screen.getByText('architecture').closest('[role="treeitem"]');
      expect(archRow).toHaveAttribute('aria-level', '3');
    });
  });

  describe('ownsPointer', () => {
    it('owns list/markdown, editor/markdown/*, and folder/markdown/*', () => {
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      expect(root.ownsPointer(new DockPointer(ViewType.ASSETS, 'list/markdown'))).toBe(true);
      expect(root.ownsPointer(DockPointer.forAssetEditor('markdown', '/foo.md'))).toBe(true);
      expect(
        root.ownsPointer(
          new DockPointer(ViewType.ASSETS, 'folder/markdown/compute_node-@local/anywhere'),
        ),
      ).toBe(true);
    });

    it('rejects other asset types and other view types', () => {
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      expect(root.ownsPointer(new DockPointer(ViewType.ASSETS, 'list/skill'))).toBe(false);
      expect(root.ownsPointer(new DockPointer(ViewType.ASSETS, 'editor/skill/foo'))).toBe(false);
      expect(root.ownsPointer(new DockPointer(ViewType.EDITOR, 'foo.md'))).toBe(false);
    });
  });

  describe('toolbar', () => {
    it('Scan toolbar action calls indexType', async () => {
      // The scan action reindexes the type; the tree refreshes off the resulting
      // data_ops (useAssetTreeRefresh) — there is no `onScanComplete` callback in
      // the flow anymore, so indexType being invoked is the whole contract.
      stageVaultFiles([]);
      const user = userEvent.setup();
      const indexType = vi.fn(async () => ({ indexed: 42 }));
      const root = markdownFolderRoot(makeType([VAULT]), { indexType });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      const scanBtn = screen.getByTestId('browseable-toolbar-scan:markdown');
      await user.click(scanBtn);
      await waitFor(() => expect(indexType).toHaveBeenCalledWith('markdown', undefined));
    });

    it('New toolbar action calls onNew', async () => {
      stageVaultFiles([]);
      const user = userEvent.setup();
      const onNew = vi.fn();
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn(), onNew });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      const newBtn = screen.getByTestId('browseable-toolbar-new:markdown');
      await user.click(newBtn);
      expect(onNew).toHaveBeenCalledWith('markdown');
    });
  });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fsStore, type FSItem } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { BrowseableTree } from '@src/components/browseable-tree';
import { markdownFolderRoot } from '@src/components/browseable-tree/adapters/markdownFolderRoot';
import type { AssetTypeInfo, AssetTypeVault } from '@src/hooks/use-asset-types';

// ---------- filesystem mock ----------

type FakeEntry = { name: string; is_dir: boolean };

function item(name: string, is_dir = false): FakeEntry {
  return { name, is_dir };
}

function stageFilesystem(tree: Record<string, FakeEntry[]>) {
  // Return a spy on fsStore.listDirectory that resolves from the staged tree.
  // Key is `typeid:relPath` (relPath '' or '/' both map to the vault root).
  const spy = vi.fn(async (typeid: { toString(): string }, path: string) => {
    const tid = typeid.toString();
    const norm = (path || '').replace(/^\/+/, '').replace(/\/+$/, '');
    const key = `${tid}:${norm}`;
    const entries = tree[key] ?? [];
    return {
      items: entries.map((e) => ({
        name: e.name,
        is_dir: e.is_dir,
        vfs_abs_path: `${tid}/${norm ? norm + '/' : ''}${e.name}`,
      })) as unknown as FSItem[],
      path: norm,
      totalSize: 0,
      itemCount: entries.length,
      fetchedAt: new Date(),
    };
  });
  vi.spyOn(fsStore, 'getState').mockReturnValue({
    listDirectory: spy,
    // minimal shape: unused fields default to undefined
  } as unknown as ReturnType<typeof fsStore.getState>);
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
  relPath: 'Users/shlom/docs',
  absPath: '/Users/shlom/docs',
  label: 'User docs',
};

describe('markdownFolderRoot adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('vault enumeration', () => {
    it('lists vaults as children of the Markdown root', async () => {
      stageFilesystem({});
      const user = userEvent.setup();
      const root = markdownFolderRoot(makeType([VAULT]), {
        indexType: vi.fn(async () => ({ indexed: 0 })),
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);

      // Expand the Markdown root
      await user.click(screen.getByTestId('browseable-chevron-asset-type:markdown'));
      await waitFor(() => expect(screen.getByText('User docs')).toBeInTheDocument());
    });

    it('markdown root without vaults renders with no children', async () => {
      stageFilesystem({});
      const user = userEvent.setup();
      const root = markdownFolderRoot(makeType([]), {
        indexType: vi.fn(async () => ({ indexed: 0 })),
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      // The root has hasChildren = (vaults.length > 0) → false when empty
      expect(screen.queryByTestId('browseable-chevron-asset-type:markdown')).not.toBeInTheDocument();
    });
  });

  describe('folder expansion + listChildren', () => {
    it('expanding a vault calls fsStore.listDirectory and renders files/folders', async () => {
      const spy = stageFilesystem({
        'compute_node-@local:Users/shlom/docs': [
          item('architecture', true),
          item('readme.md'),
        ],
      });
      const user = userEvent.setup();
      const root = markdownFolderRoot(makeType([VAULT]), {
        indexType: vi.fn(async () => ({ indexed: 0 })),
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);

      await user.click(screen.getByTestId('browseable-chevron-asset-type:markdown'));
      await waitFor(() => expect(screen.getByText('User docs')).toBeInTheDocument());
      await user.click(screen.getByTestId('browseable-chevron-md-folder:compute_node-@local:/Users/shlom/docs'));

      await waitFor(() => {
        expect(screen.getByText('architecture')).toBeInTheDocument();
        expect(screen.getByText('readme.md')).toBeInTheDocument();
      });

      expect(spy).toHaveBeenCalled();
    });

    it('filters out non-markdown files', async () => {
      stageFilesystem({
        'compute_node-@local:Users/shlom/docs': [
          item('README.md'),
          item('image.png'),
          item('subdir', true),
          item('note.md'),
        ],
      });
      const user = userEvent.setup();
      const root = markdownFolderRoot(makeType([VAULT]), {
        indexType: vi.fn(),
      });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      await user.click(screen.getByTestId('browseable-chevron-asset-type:markdown'));
      await waitFor(() => screen.getByText('User docs'));
      await user.click(screen.getByTestId('browseable-chevron-md-folder:compute_node-@local:/Users/shlom/docs'));

      await waitFor(() => {
        expect(screen.getByText('README.md')).toBeInTheDocument();
        expect(screen.getByText('note.md')).toBeInTheDocument();
        expect(screen.getByText('subdir')).toBeInTheDocument();
        expect(screen.queryByText('image.png')).not.toBeInTheDocument();
      });
    });

    it('sorts folders first then files alphabetically', async () => {
      stageFilesystem({
        'compute_node-@local:Users/shlom/docs': [
          item('zeta.md'),
          item('alpha', true),
          item('alpha.md'),
          item('beta', true),
        ],
      });
      const user = userEvent.setup();
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      await user.click(screen.getByTestId('browseable-chevron-asset-type:markdown'));
      await waitFor(() => screen.getByText('User docs'));
      await user.click(screen.getByTestId('browseable-chevron-md-folder:compute_node-@local:/Users/shlom/docs'));

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
      stageFilesystem({ 'compute_node-@local:Users/shlom/docs': [] });
      const user = userEvent.setup();
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      await user.click(screen.getByTestId('browseable-chevron-asset-type:markdown'));
      await waitFor(() => screen.getByText('User docs'));
      await user.click(screen.getByTestId('browseable-chevron-md-folder:compute_node-@local:/Users/shlom/docs'));
      await waitFor(() => expect(screen.getByText('Empty')).toBeInTheDocument());
    });
  });

  describe('click → navigation', () => {
    it('clicking a folder navigates with forAssetFolder pointer', async () => {
      stageFilesystem({
        'compute_node-@local:Users/shlom/docs': [item('architecture', true)],
      });
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      render(<BrowseableTree roots={[root]} activePointer={null} onNavigate={onNavigate} />);
      await user.click(screen.getByTestId('browseable-chevron-asset-type:markdown'));
      await waitFor(() => screen.getByText('User docs'));
      // Click the vault row text
      await user.click(screen.getByText('User docs'));
      const calls = onNavigate.mock.calls.map((c) => (c[0] as DockPointer).pointer);
      expect(calls).toContain('folder/markdown/compute_node-@local/Users/shlom/docs');
    });

    it('clicking a .md file navigates with forAssetEditor pointer', async () => {
      stageFilesystem({
        'compute_node-@local:Users/shlom/docs': [item('readme.md')],
      });
      const user = userEvent.setup();
      const onNavigate = vi.fn();
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      render(<BrowseableTree roots={[root]} activePointer={null} onNavigate={onNavigate} />);
      await user.click(screen.getByTestId('browseable-chevron-asset-type:markdown'));
      await waitFor(() => screen.getByText('User docs'));
      await user.click(screen.getByTestId('browseable-chevron-md-folder:compute_node-@local:/Users/shlom/docs'));
      await waitFor(() => screen.getByText('readme.md'));

      await user.click(screen.getByText('readme.md'));
      const editorCall = onNavigate.mock.calls
        .map((c) => (c[0] as DockPointer).pointer)
        .find((p) => p?.startsWith('editor/markdown'));
      expect(editorCall).toBe('editor/markdown/Users/shlom/docs/readme.md');
    });
  });

  describe('deep-link auto-expand', () => {
    it('activePointer = editor/markdown/<abs> auto-expands vault + intermediate folders + leaf', async () => {
      stageFilesystem({
        'compute_node-@local:Users/shlom/docs': [item('architecture', true)],
        'compute_node-@local:Users/shlom/docs/architecture': [item('backend.md')],
      });
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      const deepPointer = new DockPointer(
        ViewType.ASSETS,
        'editor/markdown/Users/shlom/docs/architecture/backend.md',
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
      stageFilesystem({
        'compute_node-@local:Users/shlom/docs': [item('architecture', true)],
      });
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      const ptr = new DockPointer(
        ViewType.ASSETS,
        'folder/markdown/compute_node-@local/Users/shlom/docs/architecture',
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
      stageFilesystem({
        'compute_node-@local:Users/shlom/docs': [
          item('architecture', true),
          item('readme.md'),
        ],
      });
      const root = markdownFolderRoot(makeType([VAULT]), { indexType: vi.fn() });
      const ptr = new DockPointer(
        ViewType.ASSETS,
        'folder/markdown/compute_node-@local/Users/shlom/docs',
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
      expect(root.ownsPointer(new DockPointer(ViewType.ASSETS, 'editor/markdown/foo.md'))).toBe(true);
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
    it('Scan toolbar action calls indexType + onScanComplete', async () => {
      stageFilesystem({});
      const user = userEvent.setup();
      const indexType = vi.fn(async () => ({ indexed: 42 }));
      const onScanComplete = vi.fn();
      const root = markdownFolderRoot(makeType([VAULT]), { indexType, onScanComplete });
      render(<BrowseableTree roots={[root]} activePointer={null} />);
      const scanBtn = screen.getByTestId('browseable-toolbar-scan:markdown');
      await user.click(scanBtn);
      await waitFor(() => expect(indexType).toHaveBeenCalledWith('markdown'));
      await waitFor(() => expect(onScanComplete).toHaveBeenCalledWith('markdown'));
    });

    it('New toolbar action calls onNew', async () => {
      stageFilesystem({});
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

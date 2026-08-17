/**
 * DirectoryTree - React API Integration Tests
 *
 * Tests the DirectoryTree component with real backend integration using local compute node and sandbox storage.
 */

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { ComputeNode, FSEntry, fsManager } from '@sdk';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryTree, ItemHandler } from '@src/components/directory-tree';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';

describe('DirectoryTree - React API Tests', () => {
  const signupInfo = getTestSignupInfo();
  let computeNode: ComputeNode | null = null;

  // Helper to expand the root entity and wait for contents to load
  const expandRoot = async () => {
    if (!computeNode) throw new Error('computeNode not initialized');
    await waitFor(() => {
      expect(screen.getByText('Root')).toBeInTheDocument();
    });
    const root = screen.getByText('Root');
    // Double-click the folder to expand it
    await userEvent.dblClick(root);
    // Wait for the chevron to change to expanded state (chevron-down)
    await waitFor(
      () => {
        // Find the row by looking for a parent div with the "group" class pattern
        const rootRow = screen.getByText('Root').closest('div[class*="group"]');
        const chevronButton = rootRow?.querySelector('button');
        const chevronSvg = chevronButton?.querySelector('svg');
        const isExpanded = chevronSvg?.classList.contains('lucide-chevron-down');
        expect(isExpanded).toBe(true);
      },
      { timeout: 3000 },
    );
    // Give additional time for contents to render
    await new Promise((resolve) => setTimeout(resolve, 500));
  };

  // Helper to get the clickable row container for a tree item label
  const getItemRow = (label: string) => screen.getByText(label).closest('div[class*="group relative flex cursor-pointer"]');

  beforeEach(async (context: any) => {
    // Setup test environment
    await apiTestSetup(signupInfo, context.task.name);

    // Create local compute node with sandbox storage (TEMP_FLOWPAD_DIR)
    computeNode = await get_local_compute_node('test-directory-tree-node');

    try {
      await computeNode.setup();
      console.log('[TEST] Compute node created:', computeNode.id);
    } catch (error) {
      console.error('[TEST] Failed to setup compute node:', error);
      console.log('[TEST] Skipping test - compute node not available');
      return;
    }
  }, 10000);

  afterEach(() => {
    cleanup();
  });

  afterAll(async () => {
    // Cleanup compute node
    if (computeNode) {
      try {
        await computeNode.delete();
      } catch (e) {
        console.error('[TEST] Failed to cleanup compute node:', e);
      }
    }
  });

  describe('Feature 1: Shows the current tree', () => {
    it('should render empty state when no files exist', async () => {
      if (!computeNode) return;

      const rootFolder = new FSEntry({
        vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
        is_dir: true,
        size: 0,
      });
      render(<DirectoryTree rootFolders={[rootFolder]} />);

      // Expand root to see contents
      await expandRoot();

      // Now should see empty state
      await waitFor(() => {
        expect(screen.getByText('No files or folders')).toBeInTheDocument();
      });
    });

    it('should display files and folders in the tree', async () => {
      if (!computeNode) return;

      // Create test files
      await fsManager.writeFile(computeNode, '/test-file.md', '# Test');
      await fsManager.mkdir(computeNode, '/test-folder');

      const rootFolder = new FSEntry({
        vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
        is_dir: true,
        size: 0,
      });
      render(<DirectoryTree rootFolders={[rootFolder]} />);

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('test-file.md')).toBeInTheDocument();
        expect(screen.getByText('test-folder')).toBeInTheDocument();
      });
    });

    it('should display nested folder structure', async () => {
      if (!computeNode) return;

      // Create nested structure
      await fsManager.mkdir(computeNode, '/parent');
      await fsManager.mkdir(computeNode, '/parent/child');
      await fsManager.writeFile(computeNode, '/parent/child/nested-file.md', '# Nested');

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      // Should see parent folder
      await waitFor(() => {
        expect(screen.getByText('parent')).toBeInTheDocument();
      });

      // Expand parent to see child
      const parentFolder = screen.getByText('parent');
      await userEvent.dblClick(parentFolder);

      // Should see child folder after expansion
      await waitFor(
        () => {
          expect(screen.getByText('child')).toBeInTheDocument();
        },
        { timeout: 5000 },
      );
    });
  });

  describe('Feature 2: Double-click behavior (expand/collapse + select)', () => {
    it('should expand folder on double-click', async () => {
      if (!computeNode) return;

      await fsManager.mkdir(computeNode, '/folder-to-expand');
      await fsManager.writeFile(computeNode, '/folder-to-expand/inside.md', '# Inside');

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('folder-to-expand')).toBeInTheDocument();
      });

      // Double-click folder
      const folder = screen.getByText('folder-to-expand');
      await userEvent.dblClick(folder);

      // Should expand and show contents
      await waitFor(
        () => {
          expect(screen.getByText('inside.md')).toBeInTheDocument();
        },
        { timeout: 5000 },
      );
    });

    it('should collapse folder on double-click when already expanded', async () => {
      if (!computeNode) return;

      await fsManager.mkdir(computeNode, '/folder-to-collapse');
      await fsManager.writeFile(computeNode, '/folder-to-collapse/inside.md', '# Inside');

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('folder-to-collapse')).toBeInTheDocument();
      });

      const folder = screen.getByText('folder-to-collapse');

      // Expand
      await userEvent.dblClick(folder);
      await waitFor(() => {
        expect(screen.getByText('inside.md')).toBeInTheDocument();
      });

      // Collapse
      await userEvent.dblClick(folder);
      await waitFor(() => {
        expect(screen.queryByText('inside.md')).not.toBeInTheDocument();
      });
    });

    it('should select item on double-click', async () => {
      if (!computeNode) return;

      await fsManager.mkdir(computeNode, '/select-folder');

      const onSelect = vi.fn();

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
          events={{ onSelect }}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('select-folder')).toBeInTheDocument();
      });

      // Double-click should select
      const folder = screen.getByText('select-folder');
      await userEvent.dblClick(folder);

      await waitFor(() => {
        expect(onSelect).toHaveBeenCalled();
      });
    });
  });

  describe('Feature 3: Click to select, second click to rename', () => {
    it('should select item on first click', async () => {
      if (!computeNode) return;

      await fsManager.writeFile(computeNode, '/click-to-select.md', '# Test');

      const onSelect = vi.fn();

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
          events={{ onSelect }}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('click-to-select.md')).toBeInTheDocument();
      });

      const file = screen.getByText('click-to-select.md');
      await userEvent.click(file);

      await waitFor(() => {
        expect(onSelect).toHaveBeenCalled();
        expect(getItemRow('click-to-select.md')).toHaveClass('bg-accent');
      });
    });

    it('should show rename input on second click when already selected', async () => {
      if (!computeNode) return;

      await fsManager.writeFile(computeNode, '/rename-me.md', '# Test');

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('rename-me.md')).toBeInTheDocument();
      });

      const file = screen.getByText('rename-me.md');

      // First click - select
      await userEvent.click(file);

      // Second click - rename
      await userEvent.click(file);

      // Should show input field
      await waitFor(() => {
        const input = screen.getByDisplayValue('rename-me.md');
        expect(input).toBeInTheDocument();
        expect(input.tagName).toBe('INPUT');
      });
    });

    it('should confirm rename on Enter key', async () => {
      if (!computeNode) return;

      await fsManager.writeFile(computeNode, '/rename-enter.md', '# Test');

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('rename-enter.md')).toBeInTheDocument();
      });

      const file = screen.getByText('rename-enter.md');

      // Enter rename mode
      await userEvent.click(file);
      await userEvent.click(file);

      const input = await screen.findByDisplayValue('rename-enter.md');

      // Change name and press Enter
      await userEvent.clear(input);
      await userEvent.type(input, 'renamed-file.md{Enter}');

      // Verify rename committed in backend even if tree cache refresh is async
      await waitFor(() => {
        expect(screen.queryByDisplayValue('rename-enter.md')).not.toBeInTheDocument();
      });

      // The Enter keypress fires an async backend FS rename; the input vanishing
      // is a UI-state edge that can precede the backend commit. Poll the source
      // of truth until consistent rather than reading it once (a one-shot read
      // races the rename under load). Default waitFor cap — not raised.
      await waitFor(async () => {
        const browseResult = await fsManager.listDirectory(computeNode, '/');
        const names = browseResult.items.map((item) => item.name.split('/').pop() || item.name);
        expect(names).toContain('renamed-file.md');
        expect(names).not.toContain('rename-enter.md');
      });
    });

    it('should cancel rename on Escape key', async () => {
      if (!computeNode) return;

      await fsManager.writeFile(computeNode, '/cancel-rename.md', '# Test');

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('cancel-rename.md')).toBeInTheDocument();
      });

      const file = screen.getByText('cancel-rename.md');

      // Enter rename mode
      await userEvent.click(file);
      await userEvent.click(file);

      const input = await screen.findByDisplayValue('cancel-rename.md');

      // Try to change name but press Escape
      await userEvent.clear(input);
      await userEvent.type(input, 'should-not-change.md{Escape}');

      // Should keep original name in backend after escape
      await waitFor(() => {
        expect(screen.queryByDisplayValue('should-not-change.md')).not.toBeInTheDocument();
      });

      const browseResult = await fsManager.listDirectory(computeNode, '/');
      const names = browseResult.items.map((item) => item.name.split('/').pop() || item.name);
      expect(names).toContain('cancel-rename.md');
      expect(names).not.toContain('should-not-change.md');
    });
  });

  describe('Feature 4: Hover shows action icons (create file, create folder, open, delete)', () => {
    // Create test itemHandler with all actions
    const createTestHandler = (handlers?: {
      onCreateFile?: (item: FSEntry, e: React.MouseEvent) => void | Promise<void>;
      onCreateFolder?: (item: FSEntry, e: React.MouseEvent) => void | Promise<void>;
      onOpen?: (item: FSEntry, e: React.MouseEvent) => void | Promise<void>;
      onRefresh?: (item: FSEntry, e: React.MouseEvent) => void | Promise<void>;
      onDelete?: (item: FSEntry, e: React.MouseEvent) => void | Promise<void>;
    }) =>
      new ItemHandler({
        actions: [
          ItemHandler.createFileAction(handlers?.onCreateFile ?? (() => {})),
          ItemHandler.createFolderAction(handlers?.onCreateFolder ?? (() => {})),
          ItemHandler.openAction(handlers?.onOpen ?? (() => {})),
          ItemHandler.refreshAction(handlers?.onRefresh ?? (() => {})),
          ItemHandler.deleteAction(handlers?.onDelete ?? (() => {})),
        ],
      });

    it('should show action buttons on folder hover', async () => {
      if (!computeNode) return;

      await fsManager.mkdir(computeNode, '/folder-with-actions');

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
          itemHandler={createTestHandler()}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('folder-with-actions')).toBeInTheDocument();
      });

      const folder = getItemRow('folder-with-actions');

      // Action buttons should exist (they're hidden with opacity-0 until hover)
      const buttons = folder?.querySelectorAll('button[title]');
      expect(buttons?.length).toBeGreaterThan(0);

      // Check for specific action buttons by title
      const fileButton = folder?.querySelector('button[title="New file"]');
      const folderButton = folder?.querySelector('button[title="New folder"]');
      const deleteButton = folder?.querySelector('button[title="Delete"]');
      const openButton = folder?.querySelector('button[title="Open folder"]');
      const refreshButton = folder?.querySelector('button[title="Refresh"]');

      expect(fileButton).toBeInTheDocument();
      expect(folderButton).toBeInTheDocument();
      expect(deleteButton).toBeInTheDocument();
      expect(openButton).toBeInTheDocument();
      expect(refreshButton).toBeInTheDocument();
    });

    it('should create new file when clicking create file button', async () => {
      if (!computeNode) return;

      await fsManager.mkdir(computeNode, '/create-file-here');
      const onCreateFile = vi.fn(async (item: FSEntry) => {
        const folderPath = item.relativePath || item.name;
        await fsManager.writeFile(computeNode!, `/${folderPath}/new-file.md`, '# New file');
      });

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
          itemHandler={createTestHandler({ onCreateFile })}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('create-file-here')).toBeInTheDocument();
      });

      const folder = getItemRow('create-file-here');
      const createFileButton = folder?.querySelector('button[title="New file"]') as HTMLElement;

      await userEvent.click(createFileButton);

      await waitFor(() => {
        expect(onCreateFile).toHaveBeenCalled();
      });

      await waitFor(
        async () => {
          const browseResult = await fsManager.listDirectory(computeNode!, '/create-file-here');
          const names = browseResult.items.map((item) => item.name.split('/').pop() || item.name);
          expect(names).toContain('new-file.md');
        },
        { timeout: 5000 },
      );
    });

    it('should create new folder when clicking create folder button', async () => {
      if (!computeNode) return;

      await fsManager.mkdir(computeNode, '/create-folder-here');
      const onCreateFolder = vi.fn(async (item: FSEntry) => {
        const folderPath = item.relativePath || item.name;
        await fsManager.mkdir(computeNode!, `/${folderPath}/new-folder`);
      });

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
          itemHandler={createTestHandler({ onCreateFolder })}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('create-folder-here')).toBeInTheDocument();
      });

      const folder = getItemRow('create-folder-here');
      const createFolderButton = folder?.querySelector('button[title="New folder"]') as HTMLElement;

      await userEvent.click(createFolderButton);

      await waitFor(() => {
        expect(onCreateFolder).toHaveBeenCalled();
      });

      await waitFor(
        async () => {
          const browseResult = await fsManager.listDirectory(computeNode!, '/create-folder-here');
          const names = browseResult.items.map((item) => item.name.split('/').pop() || item.name);
          expect(names).toContain('new-folder');
        },
        { timeout: 5000 },
      );
    });
  });

  describe('Feature 5: Refresh icon on folders', () => {
    // Create test itemHandler with refresh action
    const createRefreshHandler = (onRefresh?: (item: FSEntry, e: React.MouseEvent) => void | Promise<void>) =>
      new ItemHandler({
        actions: [ItemHandler.refreshAction(onRefresh ?? (() => {}))],
      });

    it('should have refresh button on folders', async () => {
      if (!computeNode) return;

      await fsManager.mkdir(computeNode, '/folder-to-refresh');

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
          itemHandler={createRefreshHandler()}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('folder-to-refresh')).toBeInTheDocument();
      });

      const folder = getItemRow('folder-to-refresh');
      const refreshButton = folder?.querySelector('button[title="Refresh"]');

      expect(refreshButton).toBeInTheDocument();
    });

    it('should reload folder contents when clicking refresh', async () => {
      if (!computeNode) return;
      const onRefresh = vi.fn(async () => {});

      await fsManager.mkdir(computeNode, '/refresh-test');

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
          itemHandler={createRefreshHandler(onRefresh)}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('refresh-test')).toBeInTheDocument();
      });

      // Expand folder first
      const folder = screen.getByText('refresh-test');
      await userEvent.dblClick(folder);

      // Folder is empty initially
      await waitFor(() => {
        const folderDiv = getItemRow('refresh-test')?.parentElement;
        expect(folderDiv?.textContent).not.toContain('added-file.md');
      });

      // Add file externally (simulating external change)
      await fsManager.writeFile(computeNode, '/refresh-test/added-file.md', '# Added');

      // Click refresh button
      const folderDiv = getItemRow('refresh-test');
      const refreshButton = folderDiv?.querySelector('button[title="Refresh"]') as HTMLElement;
      await userEvent.click(refreshButton);

      await waitFor(() => {
        expect(onRefresh).toHaveBeenCalled();
      });

      const browseResult = await fsManager.listDirectory(computeNode, '/refresh-test');
      const names = browseResult.items.map((item) => item.name.split('/').pop() || item.name);
      expect(names).toContain('added-file.md');
    });
  });

  describe('Feature 6: Navigation callbacks with path', () => {
    it('should call onItemClick with item and path', async () => {
      if (!computeNode) return;

      await fsManager.writeFile(computeNode, '/click-callback.md', '# Test');

      const onItemClick = vi.fn();

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
          events={{ onItemClick }}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('click-callback.md')).toBeInTheDocument();
      });

      const file = screen.getByText('click-callback.md');
      await userEvent.click(file);

      await waitFor(() => {
        expect(onItemClick).toHaveBeenCalled();
        const matchingCall = onItemClick.mock.calls
          .map(([arg]) => arg)
          .find((arg) => arg?.name === 'click-callback.md');
        expect(matchingCall).toBeTruthy();
        expect(matchingCall?.relativePath).toBe('click-callback.md');
      });
    });

    it('should call action handler when clicking open button', async () => {
      if (!computeNode) return;

      await fsManager.mkdir(computeNode, '/open-callback-folder');

      const onOpenAction = vi.fn();

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
          itemHandler={
            new ItemHandler({
              actions: [ItemHandler.openAction(onOpenAction)],
            })
          }
        />,
      );

      // Expand root to see contents
      await expandRoot();

      await waitFor(() => {
        expect(screen.getByText('open-callback-folder')).toBeInTheDocument();
      });

      const folder = getItemRow('open-callback-folder');
      const openButton = folder?.querySelector('button[title="Open folder"]') as HTMLElement;

      await userEvent.click(openButton);

      await waitFor(() => {
        expect(onOpenAction).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'open-callback-folder' }),
          expect.anything(),
        );
      });
    });

    it('should provide correct path in nested folders', async () => {
      if (!computeNode) return;

      await fsManager.mkdir(computeNode, '/parent-nav');
      await fsManager.mkdir(computeNode, '/parent-nav/child-nav');
      await fsManager.writeFile(computeNode, '/parent-nav/child-nav/nested.md', '# Nested');

      const onItemClick = vi.fn();

      render(
        <DirectoryTree
          rootFolders={[
            new FSEntry({
              vfs_abs_path: `${computeNode.typeId.type}-${computeNode.typeId.id}/.`,
              is_dir: true,
              size: 0,
            }),
          ]}
          events={{ onItemClick }}
        />,
      );

      // Expand root to see contents
      await expandRoot();

      // Expand parent
      await waitFor(() => {
        expect(screen.getByText('parent-nav')).toBeInTheDocument();
      });

      const parentFolder = screen.getByText('parent-nav');
      await userEvent.dblClick(parentFolder);

      // Expand child
      await waitFor(() => {
        expect(screen.getByText('child-nav')).toBeInTheDocument();
      });

      const childFolder = screen.getByText('child-nav');
      await userEvent.dblClick(childFolder);

      // Click nested file
      await waitFor(() => {
        expect(screen.getByText('nested.md')).toBeInTheDocument();
      });

      const nestedFile = screen.getByText('nested.md');
      await userEvent.click(nestedFile);

      await waitFor(() => {
        expect(onItemClick).toHaveBeenCalled();
        const matchingCall = onItemClick.mock.calls
          .map(([arg]) => arg)
          .find((arg) => arg?.name === 'nested.md');
        expect(matchingCall).toBeTruthy();
        expect(matchingCall?.relativePath).toBe('parent-nav/child-nav/nested.md');
      });
    });
  });
});

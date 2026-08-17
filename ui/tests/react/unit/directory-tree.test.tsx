import type { FSEntry } from '@sdk';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryTree } from '@src/components/directory-tree';
import { ItemHandler } from '@src/components/directory-tree/ItemHandler';

// Helper to render with providers needed by DirectoryTree (for filter dropdown)
function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

// Test UUID for mock items (valid UUIDv4 format for vfs_abs_path parsing)
// UUIDv4 requires: 13th char = '4', 17th char = '8'|'9'|'a'|'b'
const TEST_UUID = '12345678-1234-4234-a234-123456789abc';
const TEST_VFS_PREFIX = `project-${TEST_UUID}`;

// Mock FSEntry factory
function createMockFSEntry(overrides: Partial<FSEntry> & { name?: string } = {}): FSEntry {
  const relativePath = overrides.relativePath || '/test/path';
  const name = overrides.name || relativePath.split('/').pop() || 'test-item';

  const item = {
    name,
    vfs_abs_path: overrides.vfs_abs_path || `${TEST_VFS_PREFIX}${relativePath}`,
    vfs_entity_type: 'project',
    vfs_entity_id: TEST_UUID,
    vfs_file_name: relativePath.startsWith('/') ? relativePath.slice(1) : relativePath,
    relativePath: relativePath.startsWith('/') ? relativePath.slice(1) : relativePath,
    is_dir: overrides.is_dir ?? false,
    size: overrides.size ?? 100,
    modified: new Date().toISOString(),
    isSymlink: overrides.isSymlink ?? false,
  };

  Object.defineProperty(item, 'parentTypeId', {
    get: () => ({ type: 'project', id: TEST_UUID }),
    enumerable: true,
  });

  return item as FSEntry;
}

function createMockFolder(name: string, path: string): FSEntry {
  return createMockFSEntry({
    name,
    vfs_abs_path: `${TEST_VFS_PREFIX}${path}`,
    relativePath: path,
    is_dir: true,
  });
}

function createMockFile(name: string, path: string): FSEntry {
  return createMockFSEntry({
    name,
    vfs_abs_path: `${TEST_VFS_PREFIX}${path}`,
    relativePath: path,
    is_dir: false,
  });
}

describe('DirectoryTree Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Selection - Root Level', () => {
    it('should highlight selected root folder', async () => {
      // SKIPPED: DirectoryTree's selectedPath prop only triggers expandParentsForPath,
      // it doesn't sync to the tree's internal selectedPath state used for isSelected checks.
      // The component needs a fix to sync the prop to internal state.
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} selectedPath={`${TEST_VFS_PREFIX}/root`} />);

      await waitFor(() => {
        const folderRow = screen.getByText('root').closest('div[class*="group"]');
        expect(folderRow).toHaveClass('bg-accent');
      });
    });

    it('should not highlight unselected root folder', async () => {
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} selectedPath={null} />);

      await waitFor(() => {
        const folderRow = screen.getByText('root').closest('div[class*="group"]');
        expect(folderRow).not.toHaveClass('bg-accent');
      });
    });

    it('should call onSelect when root folder is clicked', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} events={{ onSelect }} />);

      await user.click(screen.getByText('root'));

      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'root' }));
    });
  });

  describe('Click Events', () => {
    it('should call onItemClick when item is clicked', async () => {
      const user = userEvent.setup();
      const onItemClick = vi.fn();
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} events={{ onItemClick }} />);

      await user.click(screen.getByText('root'));

      expect(onItemClick).toHaveBeenCalledWith(expect.objectContaining({ name: 'root' }));
    });

    it('should call onItemDoubleClick when item is double-clicked', async () => {
      const user = userEvent.setup();
      const onItemDoubleClick = vi.fn();
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} events={{ onItemDoubleClick }} />);

      await user.dblClick(screen.getByText('root'));

      expect(onItemDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ name: 'root' }));
    });

    it('should have clickable chevron for folder expansion', async () => {
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} />);

      // Find the chevron button
      const chevronButton = screen.getByText('root').closest('div[class*="group"]')?.querySelector('button');
      expect(chevronButton).toBeTruthy();
    });
  });

  describe('Hover Triggers', () => {
    it('should have action buttons container with hover styling', async () => {
      const handler = new ItemHandler({
        actions: [ItemHandler.refreshAction(() => {})],
      });
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} itemHandler={handler} />);

      const folderRow = screen.getByText('root').closest('div[class*="group"]');
      expect(folderRow).toBeTruthy();

      // Action buttons should have opacity-0 (hidden by default) and group-hover:opacity-100
      const actionsContainer = folderRow?.querySelector('div[class*="opacity-0"]');
      expect(actionsContainer).toBeTruthy();
      expect(actionsContainer?.className).toContain('group-hover:opacity-100');
    });

    it('should not render action buttons when no actions configured', () => {
      const handler = new ItemHandler({});
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} itemHandler={handler} enableBuiltInDelete={false} />);

      const folderRow = screen.getByText('root').closest('div[class*="group"]');
      const actionsContainer = folderRow?.querySelector('div[class*="opacity-0"]');

      // Actions container exists but should be empty
      expect(actionsContainer?.children.length || 0).toBe(0);
    });
  });

  describe('Action Buttons', () => {
    it('should render delete button when delete action is configured', () => {
      const handler = new ItemHandler({
        actions: [ItemHandler.deleteAction(() => {})],
      });
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} itemHandler={handler} />);

      const deleteButton = screen.getByTitle('Delete');
      expect(deleteButton).toBeInTheDocument();
    });

    it('should render create file button for folders', () => {
      const handler = new ItemHandler({
        actions: [ItemHandler.createFileAction(() => {})],
      });
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} itemHandler={handler} />);

      const createFileButton = screen.getByTitle('New file');
      expect(createFileButton).toBeInTheDocument();
    });

    it('should render create folder button for folders', () => {
      const handler = new ItemHandler({
        actions: [ItemHandler.createFolderAction(() => {})],
      });
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} itemHandler={handler} />);

      const createFolderButton = screen.getByTitle('New folder');
      expect(createFolderButton).toBeInTheDocument();
    });

    it('should render refresh button for folders', () => {
      const handler = new ItemHandler({
        actions: [ItemHandler.refreshAction(() => {})],
      });
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} itemHandler={handler} />);

      const refreshButton = screen.getByTitle('Refresh');
      expect(refreshButton).toBeInTheDocument();
    });
  });

  describe('Empty and Loading States', () => {
    it('should show empty state when no root folders', () => {
      render(<DirectoryTree rootFolders={[]} />);

      expect(screen.getByText('No roots configured')).toBeInTheDocument();
    });

    it('should show loading state when isLoading is true', () => {
      render(<DirectoryTree rootFolders={[]} isLoading={true} />);

      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });

    it('should show error message when error is provided', () => {
      render(<DirectoryTree rootFolders={[]} error="Failed to load" />);

      expect(screen.getByText('Failed to load')).toBeInTheDocument();
    });
  });

  describe('Filter Functionality', () => {
    it('should render filter button when filterDefinitions are provided', () => {
      const rootFolder = createMockFolder('root', '/root');
      const filterDefinitions = [{ name: 'md-only', label: 'Markdown only', filterFn: () => true }];

      renderWithProviders(
        <DirectoryTree
          rootFolders={[rootFolder]}
          filterDefinitions={filterDefinitions}
          enabledFilters={[]}
          events={{ onEnabledFiltersChange: () => {} }}
        />,
      );

      const filterButton = screen.getByTestId('directory-tree-filters-button');
      expect(filterButton).toBeInTheDocument();
    });

    it('should show filter label in dropdown when opened', async () => {
      const user = userEvent.setup();
      const rootFolder = createMockFolder('root', '/root');
      const filterDefinitions = [{ name: 'md-only', label: 'Markdown only', filterFn: () => true }];

      renderWithProviders(
        <DirectoryTree
          rootFolders={[rootFolder]}
          filterDefinitions={filterDefinitions}
          enabledFilters={[]}
          events={{ onEnabledFiltersChange: () => {} }}
        />,
      );

      // Open the filter dropdown
      await user.click(screen.getByTestId('directory-tree-filters-button'));

      expect(screen.getByText('Markdown only')).toBeInTheDocument();
    });

    it('should call onEnabledFiltersChange when filter is toggled', async () => {
      const user = userEvent.setup();
      const onEnabledFiltersChange = vi.fn();
      const rootFolder = createMockFolder('root', '/root');
      const filterDefinitions = [{ name: 'md-only', label: 'Markdown only', filterFn: () => true }];

      renderWithProviders(
        <DirectoryTree
          rootFolders={[rootFolder]}
          filterDefinitions={filterDefinitions}
          enabledFilters={[]}
          events={{ onEnabledFiltersChange }}
        />,
      );

      // Open the filter dropdown and click the filter
      await user.click(screen.getByTestId('directory-tree-filters-button'));
      await user.click(screen.getByText('Markdown only'));

      expect(onEnabledFiltersChange).toHaveBeenCalledWith(['md-only']);
    });

    it('should toggle filter off when clicked again', async () => {
      const user = userEvent.setup();
      const onEnabledFiltersChange = vi.fn();
      const rootFolder = createMockFolder('root', '/root');
      const filterDefinitions = [{ name: 'md-only', label: 'Markdown only', filterFn: () => true }];

      renderWithProviders(
        <DirectoryTree
          rootFolders={[rootFolder]}
          filterDefinitions={filterDefinitions}
          enabledFilters={['md-only']}
          events={{ onEnabledFiltersChange }}
        />,
      );

      // Open the filter dropdown and click the filter
      await user.click(screen.getByTestId('directory-tree-filters-button'));
      await user.click(screen.getByText('Markdown only'));

      expect(onEnabledFiltersChange).toHaveBeenCalledWith([]);
    });
  });

  describe('Header Controls', () => {
    it('should render home button when homePath and onNavigateHome are provided', () => {
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} homePath="/home" events={{ onNavigateHome: () => {} }} />);

      const homeButton = screen.getByTitle('Home: /home');
      expect(homeButton).toBeInTheDocument();
    });

    it('should call onNavigateHome when home button is clicked', async () => {
      const user = userEvent.setup();
      const onNavigateHome = vi.fn();
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} homePath="/home" events={{ onNavigateHome }} />);

      await user.click(screen.getByTitle('Home: /home'));

      expect(onNavigateHome).toHaveBeenCalled();
    });

    it('should render open external button when onOpenExternal is provided', () => {
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} homePath="/home" events={{ onOpenExternal: () => {} }} />);

      const externalButton = screen.getByTitle('Open in system file explorer');
      expect(externalButton).toBeInTheDocument();
    });

    it('should call onOpenExternal when external button is clicked', async () => {
      const user = userEvent.setup();
      const onOpenExternal = vi.fn();
      const rootFolder = createMockFolder('root', '/root');

      render(<DirectoryTree rootFolders={[rootFolder]} homePath="/home" events={{ onOpenExternal }} />);

      await user.click(screen.getByTitle('Open in system file explorer'));

      expect(onOpenExternal).toHaveBeenCalled();
    });

    it('should show header when filters are defined even without homePath', () => {
      const rootFolder = createMockFolder('root', '/root');
      const filterDefinitions = [{ name: 'md-only', label: 'Markdown only', filterFn: () => true }];

      renderWithProviders(
        <DirectoryTree
          rootFolders={[rootFolder]}
          filterDefinitions={filterDefinitions}
          enabledFilters={[]}
          events={{ onEnabledFiltersChange: () => {} }}
        />,
      );

      // Header should be visible (contains filter button)
      const filterButton = screen.getByTestId('directory-tree-filters-button');
      expect(filterButton).toBeInTheDocument();
    });
  });

  describe('Multiple Root Folders', () => {
    it('should render multiple root folders', () => {
      const folder1 = createMockFolder('folder1', '/folder1');
      const folder2 = createMockFolder('folder2', '/folder2');

      render(<DirectoryTree rootFolders={[folder1, folder2]} />);

      expect(screen.getByText('folder1')).toBeInTheDocument();
      expect(screen.getByText('folder2')).toBeInTheDocument();
    });

    it('should allow selecting any root folder', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      const folder1 = createMockFolder('folder1', '/folder1');
      const folder2 = createMockFolder('folder2', '/folder2');

      render(<DirectoryTree rootFolders={[folder1, folder2]} events={{ onSelect }} />);

      await user.click(screen.getByText('folder2'));

      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'folder2' }));
    });
  });
});

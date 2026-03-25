import { fsManager, fsStore, type FSItem, type FSStoreState, TypeId } from '@sdk';
import { useFSStore } from '@sdk/react/hooks';

import { useCallback, useState } from 'react';
import type { DirectoryTreeState, TreeAction } from './types';

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const maybeStatus = (error as { response?: { status?: unknown } }).response?.status;
  return typeof maybeStatus === 'number' ? maybeStatus : null;
}

/**
 * Get browse cache key for an FSItem
 */
function getBrowseCacheKey(item: FSItem): string | null {
  try {
    const typeid = item.parentTypeId;
    if (!typeid) return null;
    const relativePath = item.relativePath || '/';
    // Treat '.' as root '/' for consistent cache keys
    const normalizedPath = (relativePath === '.' ? '/' : relativePath).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    return `${typeid.toString()}:${normalizedPath}`;
  } catch {
    return null;
  }
}

/**
 * Custom hook for managing directory tree state and operations
 * Simplified to work with FSItem roots directly - no RootEntity complexity
 */
export function useDirectoryTree(rootFolders: FSItem[]) {
  const [state, setState] = useState<DirectoryTreeState>({
    expandedPaths: new Set<string>(),
    folderContents: new Map<string, FSItem[]>(), // Kept for backwards compatibility but not actively used
    selectedPath: null,
    renamingPath: null,
    renameValue: '',
    loadingPaths: new Set<string>(),
  });

  // Subscribe to shared browseCache for reactive updates
  const browseCache = useFSStore((s) => s.browseCache);

  /**
   * Extract TypeId from FSItem
   * Uses the built-in parentTypeId property which correctly parses the vfs_abs_path
   */
  const getTypeIdFromItem = useCallback((item: FSItem): TypeId | null => {
    try {
      return item.parentTypeId;
    } catch (error) {
      console.error('[useDirectoryTree] Failed to get parentTypeId from FSItem:', error, item);
      return null;
    }
  }, []);

  /**
   * Load contents of a folder (uses shared fsStore.browseCache)
   * Note: This does NOT invalidate the cache - it uses cached data if available.
   * Invalidation should only happen on explicit mutations or refresh.
   */
  const loadFolderContents = useCallback(
    async (folder: FSItem): Promise<FSItem[]> => {
      const typeid = getTypeIdFromItem(folder);
      if (!typeid) {
        console.error('[useDirectoryTree] Invalid FSItem - cannot extract TypeId:', folder);
        return [];
      }

      const pathKey = folder.vfs_abs_path;
      // Normalize '.' to '/' for root folder
      const relativePath = folder.relativePath === '.' ? '/' : folder.relativePath || '/';

      try {
        // Add to loading state
        setState((prev) => ({
          ...prev,
          loadingPaths: new Set(prev.loadingPaths).add(pathKey),
        }));

        // Fetch via shared cache (uses cached data if available)
        const result = await fsStore.getState().listDirectory(typeid, relativePath);
        const items = [...result.items];

        // Sort: folders first, then files, alphabetically
        items.sort((a, b) => {
          if (a.is_dir !== b.is_dir) {
            return a.is_dir ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

        // Clear loading state (cache update handled by fsStore)
        setState((prev) => {
          const newLoading = new Set(prev.loadingPaths);
          newLoading.delete(pathKey);
          return { ...prev, loadingPaths: newLoading };
        });

        return items;
      } catch (error) {
        // Check if this is a 404 (directory not found) - treat as empty folder
        const status = getErrorStatus(error);
        const is404 =
          status === 404 ||
          (error instanceof Error &&
            (error.message.includes('404') || error.message.includes('Not Found') || error.message.includes('not found')));
        const is403 = status === 403;

        setState((prev) => {
          const newLoading = new Set(prev.loadingPaths);
          newLoading.delete(pathKey);
          return { ...prev, loadingPaths: newLoading };
        });

        if (is403) {
          console.warn(`[useDirectoryTree] Permission denied for folder ${pathKey}`);
        } else if (!is404) {
          console.error(`[useDirectoryTree] Failed to load folder ${pathKey}:`, error);
        }
        return [];
      }
    },
    [getTypeIdFromItem],
  );

  /**
   * Toggle folder expansion
   */
  const toggleExpanded = useCallback(
    async (folder: FSItem) => {
      const pathKey = folder.vfs_abs_path;

      // Check if we need to load BEFORE setState to avoid React 18 batching issues
      const isCurrentlyExpanded = state.expandedPaths.has(pathKey);
      const cacheKey = getBrowseCacheKey(folder);
      const hasContents = cacheKey ? browseCache.has(cacheKey) : false;
      const needsLoad = !isCurrentlyExpanded && !hasContents;

      setState((prev) => {
        const newExpanded = new Set(prev.expandedPaths);

        if (prev.expandedPaths.has(pathKey)) {
          // Collapse
          newExpanded.delete(pathKey);
        } else {
          // Expand
          newExpanded.add(pathKey);
        }

        return { ...prev, expandedPaths: newExpanded };
      });

      // Load contents if needed
      if (needsLoad) {
        await loadFolderContents(folder);
      }
    },
    [loadFolderContents, state.expandedPaths, browseCache],
  );

  /**
   * Select an item
   */
  const selectItem = useCallback((path: string | null) => {
    setState((prev) => ({ ...prev, selectedPath: path }));
  }, []);

  /**
   * Expand all parent folders for a given path string
   * This is used when navigating to a specific path (e.g., from URL)
   */
  const expandParentsForPath = useCallback(
    async (targetPath: string) => {
      // Find which root folder contains this path
      // Support both full vfs_abs_path and relative paths
      let matchingRoot: FSItem | null = null;
      let relativePart = '';

      for (const root of rootFolders) {
        // First try matching against vfs_abs_path (for full paths like in Skills view)
        if (targetPath.startsWith(root.vfs_abs_path)) {
          matchingRoot = root;
          relativePart = targetPath.substring(root.vfs_abs_path.length);
          break;
        }

        // Then try matching against relativePath (for relative paths like in Explorer view)
        // The Computer root has relativePath "." which represents "/"
        const rootRelPath = root.relativePath === '.' ? '/' : `/${root.relativePath}`;
        if (
          targetPath === rootRelPath ||
          targetPath.startsWith(rootRelPath + '/') ||
          targetPath.startsWith('/' + root.relativePath + '/')
        ) {
          matchingRoot = root;
          // Calculate relative part - handle the "." case for root
          if (root.relativePath === '.') {
            relativePart = targetPath; // The whole path is relative to root
          } else {
            // Remove the root's relative path prefix
            const prefix = targetPath.startsWith('/') ? '/' + root.relativePath : root.relativePath;
            relativePart = targetPath.substring(prefix.length);
          }
          break;
        }
      }

      if (!matchingRoot) {
        return;
      }
      if (!relativePart || relativePart === '/') {
        // Target is the root itself, just ensure it's expanded and selected
        await loadFolderContents(matchingRoot);
        setState((prev) => ({
          ...prev,
          expandedPaths: new Set(prev.expandedPaths).add(matchingRoot.vfs_abs_path),
          selectedPath: targetPath,
        }));
        return;
      }

      // Parse the path segments (e.g., "/test/SKILL.md" -> ["test", "SKILL.md"])
      const segments = relativePart.split('/').filter(Boolean);

      // Collect all paths to expand and load all folder contents first
      const pathsToExpand: string[] = [matchingRoot.vfs_abs_path];
      // For the base path, handle the special case where root path ends with "." (VFS root)
      // The children will have paths like "compute_node-@local/Users" not "compute_node-@local/./Users"
      const basePath = matchingRoot.vfs_abs_path.endsWith('/.')
        ? matchingRoot.vfs_abs_path.slice(0, -1) // Remove trailing "." to get "compute_node-@local/"
        : matchingRoot.vfs_abs_path;
      let currentPath = basePath;
      let currentFolder: FSItem = matchingRoot;

      // Load root contents first
      let contents = await loadFolderContents(currentFolder);

      // Detect entity prefix mismatch (e.g., root uses @local alias, children use full UUID)
      // The root folder may have vfs_abs_path like "compute_node-@local/..." but children
      // returned from the server listing use the resolved UUID "compute_node-<uuid>/..."
      if (contents && contents.length > 0) {
        const rootPrefix = currentPath.split('/')[0];
        const childPrefix = contents[0].vfs_abs_path.split('/')[0];
        if (rootPrefix !== childPrefix) {
          currentPath = childPrefix + currentPath.substring(rootPrefix.length);
        }
      }

      // Traverse and load each parent folder along the path
      // We process all segments and check if each is a folder
      // Track the last found item to use its actual vfs_abs_path for selection
      let lastFoundItem: FSItem | null = null;

      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        currentPath = currentPath.endsWith('/') ? `${currentPath}${segment}` : `${currentPath}/${segment}`;

        // Find the child in the loaded contents
        let child = contents?.find((item) => item.vfs_abs_path === currentPath);
        if (!child) {
          // Child not found - cache may be stale (e.g. folder was just created externally).
          // Invalidate the parent's cache and retry once.
          const typeid = getTypeIdFromItem(currentFolder);
          if (typeid) {
            const folderRelPath = currentFolder.relativePath === '.' ? '/' : currentFolder.relativePath || '/';
            fsStore.getState().invalidate(typeid, folderRelPath, 'browse');
            contents = await loadFolderContents(currentFolder);
            child = contents?.find((item) => item.vfs_abs_path === currentPath);
          }
          if (!child) {
            break;
          }
        }

        lastFoundItem = child;

        // If it's a folder, add to paths to expand and load its contents
        if (child.is_dir) {
          pathsToExpand.push(currentPath);
          // Load this folder's contents for the next iteration (or for the folder itself if it's the target)
          contents = await loadFolderContents(child);
          currentFolder = child;
        }
        // If it's a file (last segment), we're done - no need to expand it
      }

      // Single state update with all expanded paths and selection
      // Use the actual found item's path to ensure selection works correctly
      const selectionPath = lastFoundItem?.vfs_abs_path ?? targetPath;

      setState((prev) => {
        const newExpanded = new Set(prev.expandedPaths);
        for (const path of pathsToExpand) {
          newExpanded.add(path);
        }
        return {
          ...prev,
          expandedPaths: newExpanded,
          selectedPath: selectionPath,
        };
      });
    },
    [rootFolders, loadFolderContents, getTypeIdFromItem],
  );

  /**
   * Expand all parent folders to make a path visible
   */
  const expandToPath = useCallback(
    async (targetItem: FSItem) => {
      // For now, just expand the target if it's a folder
      // More complex path expansion can be added later if needed
      if (targetItem.is_dir) {
        setState((prev) => ({
          ...prev,
          expandedPaths: new Set(prev.expandedPaths).add(targetItem.vfs_abs_path),
        }));

        // Load contents if not already loaded (check shared cache)
        const cacheKey = getBrowseCacheKey(targetItem);
        if (!cacheKey || !browseCache.has(cacheKey)) {
          await loadFolderContents(targetItem);
        }
      }

      // Select the target
      setState((prev) => ({ ...prev, selectedPath: targetItem.vfs_abs_path }));
    },
    [loadFolderContents, browseCache],
  );

  /**
   * Start renaming an item
   */
  const startRename = useCallback((item: FSItem) => {
    setState((prev) => ({
      ...prev,
      renamingPath: item.vfs_abs_path,
      renameValue: item.name,
    }));
  }, []);

  /**
   * Cancel rename
   */
  const cancelRename = useCallback(() => {
    setState((prev) => ({
      ...prev,
      renamingPath: null,
      renameValue: '',
    }));
  }, []);

  /**
   * Perform rename operation
   */
  const performRename = useCallback(
    async (item: FSItem, newName: string): Promise<boolean> => {
      if (!newName.trim()) return false;

      const typeid = getTypeIdFromItem(item);
      if (!typeid) return false;

      try {
        await fsManager.rename(typeid, item.relativePath || item.name, newName.trim());

        // Invalidate parent folder's browse cache
        const parentPath = (item.relativePath || '/').split('/').slice(0, -1).join('/') || '/';
        fsStore.getState().invalidate(typeid, parentPath, 'browse');

        // Clear rename state
        cancelRename();

        return true;
      } catch (error) {
        console.error('[useDirectoryTree] Failed to rename:', error);
        return false;
      }
    },
    [getTypeIdFromItem, cancelRename],
  );

  /**
   * Create a new file
   */
  const createFile = useCallback(
    async (parentFolder: FSItem, fileName: string = 'new-file.md'): Promise<boolean> => {
      const typeid = getTypeIdFromItem(parentFolder);
      if (!typeid) return false;

      try {
        const parentPath = parentFolder.relativePath || '/';
        const fileRelPath = `${parentPath}/${fileName}`.replace(/\/+/g, '/');
        await fsManager.writeFile(typeid, fileRelPath, '# New File\n\nAdd your content here...\n');

        // Invalidate parent's browse cache and reload
        fsStore.getState().invalidate(typeid, parentPath, 'browse');
        await loadFolderContents(parentFolder);

        // Ensure folder is expanded
        setState((prev) => ({
          ...prev,
          expandedPaths: new Set(prev.expandedPaths).add(parentFolder.vfs_abs_path),
        }));

        return true;
      } catch (error) {
        console.error('[useDirectoryTree] Failed to create file:', error);
        return false;
      }
    },
    [getTypeIdFromItem, loadFolderContents],
  );

  /**
   * Create a new folder
   */
  const createFolder = useCallback(
    async (parentFolder: FSItem, folderName: string = 'new-folder'): Promise<boolean> => {
      const typeid = getTypeIdFromItem(parentFolder);
      if (!typeid) return false;

      try {
        const parentPath = parentFolder.relativePath || '/';
        const folderRelPath = `${parentPath}/${folderName}`.replace(/\/+/g, '/');

        try {
          await fsManager.mkdir(typeid, folderRelPath);
        } catch (mkdirError: unknown) {
          // Handle 409 Conflict (folder already exists) - that's OK, just continue
          const is409 =
            mkdirError instanceof Error &&
            (mkdirError.message.includes('409') ||
              mkdirError.message.includes('Conflict') ||
              mkdirError.message.includes('already exists'));
          if (!is409) {
            throw mkdirError;
          }
          console.log(`[useDirectoryTree] Folder ${folderName} already exists, continuing...`);
        }

        // Invalidate parent's browse cache and reload
        fsStore.getState().invalidate(typeid, parentPath, 'browse');
        await loadFolderContents(parentFolder);

        // Ensure parent is expanded
        setState((prev) => ({
          ...prev,
          expandedPaths: new Set(prev.expandedPaths).add(parentFolder.vfs_abs_path),
        }));

        return true;
      } catch (error) {
        console.error('[useDirectoryTree] Failed to create folder:', error);
        return false;
      }
    },
    [getTypeIdFromItem, loadFolderContents],
  );

  /**
   * Delete an item
   */
  const deleteItem = useCallback(
    async (item: FSItem): Promise<boolean> => {
      const typeid = getTypeIdFromItem(item);
      if (!typeid) return false;

      try {
        await fsManager.delete(typeid, item.relativePath || item.name);

        // Invalidate parent folder's browse cache
        const parentPath = (item.relativePath || '/').split('/').slice(0, -1).join('/') || '/';
        fsStore.getState().invalidate(typeid, parentPath, 'browse');

        // Clear selection if deleted item was selected
        setState((prev) => ({
          ...prev,
          selectedPath: prev.selectedPath === item.vfs_abs_path ? null : prev.selectedPath,
        }));

        return true;
      } catch (error) {
        console.error('[useDirectoryTree] Failed to delete:', error);
        return false;
      }
    },
    [getTypeIdFromItem],
  );

  /**
   * Refresh a folder's contents (invalidates cache and fetches fresh data)
   */
  const refresh = useCallback(
    async (folder?: FSItem) => {
      if (!folder) {
        // Clear all browse cache so every folder fetches fresh data
        fsStore.setState((s: FSStoreState) => {
          s.browseCache.clear();
        });
        // Recursively reload all expanded folders
        const reloadExpanded = async (items: FSItem[]) => {
          for (const item of items) {
            if (item.is_dir && state.expandedPaths.has(item.vfs_abs_path)) {
              const children = await loadFolderContents(item);
              await reloadExpanded(children);
            }
          }
        };
        await reloadExpanded(rootFolders);
      } else {
        const typeid = getTypeIdFromItem(folder);
        if (typeid) {
          fsStore.getState().invalidate(typeid, folder.relativePath || '/', 'browse');
        }
        await loadFolderContents(folder);
      }
    },
    [rootFolders, state.expandedPaths, loadFolderContents, getTypeIdFromItem],
  );

  /**
   * Handle tree actions
   */
  const handleAction = useCallback(
    async (action: TreeAction, item: FSItem, data?: unknown): Promise<boolean> => {
      // Type guard for data parameter
      const actionData = (data || {}) as { newName?: string; destPath?: string };

      switch (action) {
        case 'create-file':
          return createFile(item.is_dir ? item : rootFolders[0]);
        case 'create-folder':
          return createFolder(item.is_dir ? item : rootFolders[0]);
        case 'rename':
          return performRename(item, actionData.newName || '');
        case 'delete':
          return deleteItem(item);
        default:
          console.warn(`[useDirectoryTree] Unsupported action: ${action}`);
          return false;
      }
    },
    [createFile, createFolder, performRename, deleteItem, rootFolders],
  );

  return {
    // State
    state,
    setState,
    rootFolders,

    // Methods
    loadFolderContents,
    toggleExpanded,
    selectItem,
    expandParentsForPath,
    expandToPath,
    startRename,
    cancelRename,
    performRename,
    createFile,
    createFolder,
    deleteItem,
    refresh,
    handleAction,

    // Helpers
    isExpanded: (item: FSItem) => state.expandedPaths.has(item.vfs_abs_path),
    isSelected: (item: FSItem) => state.selectedPath === item.vfs_abs_path,
    isRenaming: (item: FSItem) => state.renamingPath === item.vfs_abs_path,
    isLoading: (item: FSItem) => state.loadingPaths.has(item.vfs_abs_path),
    getContents: (item: FSItem) => {
      // Read from shared browseCache
      const cacheKey = getBrowseCacheKey(item);
      if (!cacheKey) return [];
      const cached = browseCache.get(cacheKey);
      if (!cached) return [];
      // Sort: folders first, then files, alphabetically
      const items = [...cached.items];
      items.sort((a, b) => {
        if (a.is_dir !== b.is_dir) {
          return a.is_dir ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
      return items;
    },
  };
}

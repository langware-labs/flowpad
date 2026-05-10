import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { FSItem } from '@sdk';
import { Button } from '@src/components/ui/button';
import { ChevronDown, ChevronRight, ExternalLink, Folder, Home } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { FilterDropdown } from './FilterDropdown';
import { ItemHandler } from './ItemHandler';
import type { DirectoryTreeHandle, DirectoryTreeProps } from './types';
import { useDirectoryTree } from './useDirectoryTree';

/**
 * DirectoryTree - Generic reusable directory tree component
 *
 * Simplified component that accepts FSItem folder objects as roots.
 * Features:
 * - Multiple FSItem folder roots
 * - Lazy loading of folder contents
 * - Expand/collapse folders
 * - Selection highlighting
 * - Inline rename on double-click
 * - Action buttons (create file/folder, delete)
 * - Customizable rendering
 */
export const DirectoryTree = forwardRef<DirectoryTreeHandle, DirectoryTreeProps>(function DirectoryTree(
  {
    rootFolders = [],
    selectedPath = null,
    itemHandler,
    className = '',
    events,
    isLoading: externalLoading = false,
    error = null,
    homePath = null,
    showHeader,
    filterDefinitions,
    enabledFilters,
    enableBuiltInDelete = true,
    disableAutoSelect = false,
  },
  ref,
) {
  // State for built-in delete confirmation
  const [itemToDelete, setItemToDelete] = useState<FSItem | null>(null);

  // Extract event handlers from events object
  const onItemClick = events?.onItemClick;
  const onItemDoubleClick = events?.onItemDoubleClick;
  const onSelect = events?.onSelect;
  const onNavigateHome = events?.onNavigateHome;
  const onOpenExternal = events?.onOpenExternal;
  const onEnabledFiltersChange = events?.onEnabledFiltersChange;
  const onItemDeleted = events?.onItemDeleted;

  // Show header if explicitly set, or if homePath is provided, or if filters are defined
  const shouldShowHeader =
    showHeader !== undefined ? showHeader : homePath !== null || (filterDefinitions && filterDefinitions.length > 0);
  const tree = useDirectoryTree(rootFolders);

  const clickTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const hasExpandedRef = useRef<string | null>(null);

  // Validate that all root folders are actually folders
  useEffect(() => {
    for (const root of rootFolders) {
      if (!root.is_dir) {
        console.error('[DirectoryTree] Invalid root - must be a folder (is_dir=true):', root);
      }
    }
  }, [rootFolders]);

  // Load all root contents on mount (skip already-cached folders)
  useEffect(() => {
    for (const root of rootFolders) {
      if (root.is_dir && !tree.state.folderContents.has(root.vfs_abs_path)) {
        void tree.loadFolderContents(root);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootFolders.length, tree.loadFolderContents]);

  useImperativeHandle(ref, () => ({ refresh: () => tree.refresh() }), [tree.refresh]);

  // Reset hasExpandedRef and hasAutoSelectedRef when rootFolders changes to allow re-expansion
  // This handles the case where selectedPath is set before rootFolders is populated
  const hasAutoSelectedRef = useRef(false);
  useEffect(() => {
    if (rootFolders.length > 0) {
      hasExpandedRef.current = null;
      hasAutoSelectedRef.current = false;
    }
  }, [rootFolders.length]);

  // Sync external selected path and expand parent folders
  useEffect(() => {
    tree.selectItem(selectedPath);

    // Only expand once per selectedPath to avoid infinite loops
    // Also require rootFolders to be populated before attempting expansion
    if (selectedPath && selectedPath !== hasExpandedRef.current && rootFolders.length > 0) {
      hasExpandedRef.current = selectedPath;
      tree.expandParentsForPath(selectedPath).then(() => {
        // After expansion completes, scroll the selected item into view
        requestAnimationFrame(() => {
          const el = document.querySelector('[data-tree-path="' + CSS.escape(selectedPath) + '"]');
          el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath, tree.expandParentsForPath, rootFolders.length]);

  // Auto-select first entry when selectedPath is null and entries exist
  useEffect(() => {
    // Only auto-select once, when selectedPath is null and we have root folders
    if (disableAutoSelect || selectedPath !== null || rootFolders.length === 0 || hasAutoSelectedRef.current) {
      return;
    }

    // Check if first root folder has loaded contents
    const firstRoot = rootFolders[0];
    const entries = tree.getContents(firstRoot);

    if (entries.length > 0) {
      hasAutoSelectedRef.current = true;
      onSelect?.(entries[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disableAutoSelect, selectedPath, rootFolders, tree.state.folderContents, onSelect]);

  /**
   * Check if an item is a root folder (should not be renamed or deleted)
   * Uses VFSPath comparison for robust path matching (handles protocol normalization)
   */
  const isRootFolder = useCallback(
    (item: FSItem) => {
      return rootFolders.some((root) => {
        const rootPath = root.vfsPath;
        const itemPath = item.vfsPath;
        if (rootPath && itemPath && typeof rootPath.equals === 'function') {
          return rootPath.equals(itemPath);
        }
        return root.vfs_abs_path === item.vfs_abs_path;
      });
    },
    [rootFolders],
  );

  /**
   * Built-in delete confirmation handler
   */
  const handleDeleteConfirm = useCallback(async () => {
    if (!itemToDelete) return;

    try {
      const success = await tree.deleteItem(itemToDelete);
      if (success) {
        onItemDeleted?.(itemToDelete);
      }
    } catch (error) {
      console.error('[DirectoryTree] Failed to delete item:', error);
    } finally {
      setItemToDelete(null);
    }
  }, [itemToDelete, tree, onItemDeleted]);

  /**
   * Create handler with built-in delete action if enabled
   * User-provided deleteAction in itemHandler takes precedence
   */
  const handler = useMemo(() => {
    const baseHandler = itemHandler ?? new ItemHandler({});

    // Check if user already provided a delete action
    const hasUserDeleteAction = itemHandler
      ?.getHoverActions({ is_dir: false } as FSItem)
      .some((a) => a.name === 'delete');

    if (enableBuiltInDelete && !hasUserDeleteAction) {
      // Create a new handler that includes the built-in delete action
      const existingActions = baseHandler.getHoverActions({ is_dir: true } as FSItem);
      return new ItemHandler({
        renderIcon: (item) => baseHandler.renderIcon(item),
        renderItem: (item, level) => baseHandler.renderItem(item, level),
        isSelectable: (item) => baseHandler.isSelectable(item),
        getSelectionStyle: (item) => baseHandler.getSelectionStyle(item),
        actions: [
          // Include existing actions from base handler (reconstructed as ActionConfigs)
          ...existingActions.map((action) => ({
            ...action,
            isVisible: () => true,
          })),
          // Add built-in delete action (hidden for root folders)
          ItemHandler.deleteAction((item, e) => {
            e.stopPropagation();
            if (!isRootFolder(item)) {
              setItemToDelete(item);
            }
          }),
        ],
      });
    }

    return baseHandler;
  }, [itemHandler, enableBuiltInDelete, isRootFolder]);

  /**
   * Handle item click
   */
  const handleItemClick = useCallback(
    (item: FSItem) => {
      // For folders, toggle expand/collapse on single click
      if (item.is_dir) {
        void tree.toggleExpanded(item);
      }

      // If already selected, start rename on second click (with delay to allow double-click)
      // But don't allow renaming root folders
      if (tree.isSelected(item) && !isRootFolder(item)) {
        // Clear any existing timeout
        if (clickTimeoutRef.current) {
          clearTimeout(clickTimeoutRef.current);
        }

        // Delay rename to distinguish from double-click
        clickTimeoutRef.current = setTimeout(() => {
          tree.startRename(item);
          clickTimeoutRef.current = null;
        }, 200);
      } else {
        tree.selectItem(item.vfs_abs_path);
        onSelect?.(item);
        onItemClick?.(item);
      }
    },
    [tree, onSelect, onItemClick, isRootFolder],
  );

  /**
   * Handle item double-click
   */
  const handleItemDoubleClick = useCallback(
    (item: FSItem) => {
      // Cancel any pending click timeout to prevent rename
      if (clickTimeoutRef.current) {
        clearTimeout(clickTimeoutRef.current);
        clickTimeoutRef.current = null;
      }

      // Always select on double-click
      if (!tree.isSelected(item)) {
        tree.selectItem(item.vfs_abs_path);
        onSelect?.(item);
      }

      // Toggle expand/collapse for folders
      if (item.is_dir) {
        void tree.toggleExpanded(item);
      }

      onItemDoubleClick?.(item);
    },
    [tree, onSelect, onItemDoubleClick],
  );

  /**
   * Handle rename submit
   */
  const handleRenameSubmit = useCallback(
    async (item: FSItem) => {
      await tree.performRename(item, tree.state.renameValue);
    },
    [tree],
  );

  /**
   * Render a tree item (file or folder)
   */
  const renderTreeItem = useCallback(
    (item: FSItem, level: number = 0) => {
      const isSelected = tree.isSelected(item);
      const isRenaming = tree.isRenaming(item);
      const isExpanded = item.is_dir && tree.isExpanded(item);
      let contents = item.is_dir ? tree.getContents(item) : [];
      const isItemLoading = tree.isLoading(item);

      // Apply filters to contents if enabled
      if (filterDefinitions && enabledFilters && enabledFilters.length > 0) {
        const activeFilterDefs = filterDefinitions.filter((f) => enabledFilters.includes(f.name));
        if (activeFilterDefs.length > 0) {
          contents = contents.filter((child) => activeFilterDefs.every((f) => f.filterFn(child)));
        }
      }

      const selectionStyle = handler.getSelectionStyle(item);

      return (
        <div key={item.vfs_abs_path} data-tree-path={item.vfs_abs_path}>
          {/* Item row */}
          <div
            className={`group relative flex cursor-pointer items-center gap-1 rounded-md p-1.5 text-xs transition-colors ${
              isSelected ? (selectionStyle.className ?? 'bg-accent') : 'hover:bg-muted'
            }`}
            style={{ marginLeft: `${level * 16}px`, ...(isSelected ? selectionStyle.style : {}) }}
          >
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              {/* Chevron for folders */}
              {item.is_dir ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void tree.toggleExpanded(item);
                  }}
                  className="flex-shrink-0"
                  disabled={isItemLoading}
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  )}
                </button>
              ) : (
                <div className="w-3" /> // Spacer for files
              )}

              {/* Item content */}
              <div
                className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
                onClick={() => handler.isSelectable(item) && handleItemClick(item)}
                onDoubleClick={() => handleItemDoubleClick(item)}
              >
                {/* Icon */}
                {handler.renderIcon(item)}

                {/* Name or rename input */}
                {isRenaming ? (
                  <input
                    type="text"
                    value={tree.state.renameValue}
                    onChange={(e) =>
                      tree.setState((prev) => ({
                        ...prev,
                        renameValue: e.target.value,
                      }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        void handleRenameSubmit(item);
                      } else if (e.key === 'Escape') {
                        tree.cancelRename();
                      }
                    }}
                    onBlur={() => tree.cancelRename()}
                    className="flex-1 rounded border bg-background px-1 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate" title={item.name || ''}>
                    {handler.renderItem(item, level)}
                  </span>
                )}
              </div>
            </div>

            {/* Action buttons from handler */}
            {!isRenaming && (
              <div className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 rounded-md bg-background/80 px-1 py-0.5 opacity-0 shadow-sm backdrop-blur group-hover:opacity-100">
                {handler.getHoverActions(item).map((action) => {
                  const IconComponent = action.icon;
                  return (
                    <Button
                      key={action.name}
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={(e) => void action.onClick(item, e)}
                      title={action.tooltip}
                    >
                      <IconComponent className="h-3 w-3" />
                    </Button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Nested folder contents */}
          {isExpanded && contents.length > 0 && (
            <div className="space-y-0.5">{contents.map((child) => renderTreeItem(child, level + 1))}</div>
          )}

          {/* Empty state for folder */}
          {isExpanded && !isItemLoading && contents.length === 0 && (
            <div className="ml-8 p-2 text-xs text-muted-foreground">No files or folders</div>
          )}

          {/* Loading state for folder */}
          {isExpanded && isItemLoading && <div className="ml-8 p-2 text-xs text-muted-foreground">Loading...</div>}
        </div>
      );
    },
    [tree, handler, handleItemClick, handleItemDoubleClick, handleRenameSubmit, filterDefinitions, enabledFilters],
  );

  // Show loading state
  if (externalLoading) {
    return <div className={`p-4 text-center text-xs text-muted-foreground ${className}`}>Loading...</div>;
  }

  // Show error state
  if (error) {
    return <div className={`p-4 text-center text-xs text-destructive ${className}`}>{error}</div>;
  }

  // Show empty state if no roots
  if (rootFolders.length === 0) {
    return (
      <div className={`p-4 text-center ${className}`}>
        <Folder className="mx-auto h-8 w-8 text-muted-foreground/50" />
        <p className="mt-2 text-xs text-muted-foreground">No roots configured</p>
      </div>
    );
  }

  // Render all root folders using the same renderTreeItem function
  return (
    <div className={`flex h-full flex-col ${className}`}>
      {/* Optional header with Home, Open Externally buttons and filters */}
      {shouldShowHeader && (
        <div className="flex items-center gap-1 border-b p-1.5">
          {onNavigateHome && homePath && (
            <Button variant="ghost" size="sm" onClick={onNavigateHome} title={`Home: ${homePath}`} className="h-7 px-2">
              <Home className="h-3.5 w-3.5" />
            </Button>
          )}
          {onOpenExternal && homePath && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenExternal}
              title="Open in system file explorer"
              className="h-7 px-2"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
          {/* Filter dropdown */}
          {filterDefinitions && filterDefinitions.length > 0 && onEnabledFiltersChange && (
            <div className="ml-auto">
              <FilterDropdown
                filters={filterDefinitions}
                enabledFilters={enabledFilters ?? []}
                onFiltersChange={onEnabledFiltersChange}
              />
            </div>
          )}
        </div>
      )}

      {/* Tree content */}
      <div className="flex-1 space-y-0.5 overflow-auto p-1">
        {rootFolders.map((rootFolder) => {
          if (!rootFolder.is_dir) {
            return null; // Skip non-folders (already logged in validation useEffect)
          }
          // Render root folders at level 0 using the shared rendering logic
          return renderTreeItem(rootFolder, 0);
        })}
      </div>

      {/* Built-in delete confirmation dialog */}
      <ConfirmDialog
        open={itemToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setItemToDelete(null);
        }}
        title="Delete Item"
        description={`Are you sure you want to delete "${itemToDelete?.name || ''}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => void handleDeleteConfirm()}
      />
    </div>
  );
});

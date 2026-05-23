import type { FSItem, TypeId } from '@sdk';
import type { ItemHandler } from './ItemHandler';

/**
 * Represents a root entity in the directory tree (legacy, kept for ProjectsDirectoryTree)
 * @deprecated Use rootFolders with FSItem[] instead
 */
export interface RootEntity {
  /** Entity TypeId to browse */
  typeid: TypeId;
  /** Display label (defaults to entity.name or entity.identifier) */
  label?: string;
  /** Starting path within the entity (default: '/') */
  basePath?: string;
}

/**
 * Tree node with expansion state
 */
export interface TreeNode {
  /** The FSItem entity */
  item: FSItem;
  /** Whether the node is expanded (folders only) */
  isExpanded: boolean;
  /** Child nodes (loaded lazily) */
  children: FSItem[];
  /** Whether children are being loaded */
  isLoading: boolean;
}

/**
 * Action types supported by the directory tree
 */
export type TreeAction =
  | 'create-file'
  | 'create-folder'
  | 'rename'
  | 'delete'
  | 'copy'
  | 'move'
  | 'open'
  | 'open-in-explorer';

/**
 * Action handler function type
 */
export type TreeActionHandler = (action: TreeAction, item: FSItem, data?: unknown) => void | Promise<void>;

/**
 * Filter definition for directory tree items
 */
export interface FilterDefinition {
  /** Unique filter name/id */
  name: string;
  /** Display label */
  label: string;
  /** Filter function to test items */
  filterFn: (item: FSItem) => boolean;
}

/**
 * Event handlers for the DirectoryTree component
 */
export interface DirectoryTreeEvents {
  /** Callback when an item is clicked */
  onItemClick?: (item: FSItem) => void;

  /** Callback when an item is double-clicked */
  onItemDoubleClick?: (item: FSItem) => void;

  /** Callback when an item is selected */
  onSelect?: (item: FSItem | null) => void;

  /** Callback when Home button is clicked */
  onNavigateHome?: () => void;

  /** Callback when Open Externally button is clicked */
  onOpenExternal?: () => void;

  /** Callback when enabled filters change */
  onEnabledFiltersChange?: (filters: string[]) => void;

  /** Callback after an item is successfully deleted (built-in delete handling) */
  onItemDeleted?: (item: FSItem) => void;
}

/**
 * Props for the DirectoryTree component
 */
export interface DirectoryTreeProps {
  /** Array of root folder FSItems to display in the tree (must be folders) */
  rootFolders?: FSItem[];

  /** Currently selected item path */
  selectedPath?: string | null;

  /**
   * Item handler instance for customizing rendering, actions, and selection.
   * Use `new ItemHandler({...})` to create an instance.
   *
   * @example
   * ```tsx
   * const handler = new ItemHandler({
   *   actions: [
   *     ItemHandler.createFileAction(handleCreateFile),
   *     ItemHandler.deleteAction(handleDelete),
   *   ],
   * });
   * <DirectoryTree itemHandler={handler} />
   * ```
   */
  itemHandler?: ItemHandler;

  /** Additional CSS class */
  className?: string;

  /** Event handlers for tree interactions */
  events?: DirectoryTreeEvents;

  /** Loading state */
  isLoading?: boolean;

  /** Error message */
  error?: string | null;

  /** Home path for Home button navigation */
  homePath?: string | null;

  /** Show header with Home/Open Externally buttons (defaults to homePath != null or filters exist) */
  showHeader?: boolean;

  /** Filter definitions available for this tree */
  filterDefinitions?: FilterDefinition[];

  /** Currently enabled filter names */
  enabledFilters?: string[];

  /**
   * Enable built-in delete handling with confirmation dialog.
   * When true, DirectoryTree handles delete internally with proper cache clearing.
   * Consumers are notified via events.onItemDeleted callback.
   * Default: true
   */
  enableBuiltInDelete?: boolean;

  /**
   * Disable auto-selection of first item when selectedPath is null.
   * Default: false (auto-select is enabled)
   */
  disableAutoSelect?: boolean;
}

/**
 * Imperative handle exposed by DirectoryTree via ref
 */
export interface DirectoryTreeHandle {
  refresh: () => Promise<void>;
}

/**
 * State for directory tree management
 */
export interface DirectoryTreeState {
  /** Set of expanded folder paths (use vfs_abs_path as key) */
  expandedPaths: Set<string>;
  /** Map of folder path to its contents (key: vfs_abs_path) */
  folderContents: Map<string, FSItem[]>;
  /** Currently selected item path (vfs_abs_path or null) */
  selectedPath: string | null;
  /** Item being renamed (vfs_abs_path or null) */
  renamingPath: string | null;
  /** New name value during rename */
  renameValue: string;
  /** True while performRename is awaiting the backend; used to guard onBlur. */
  renameCommitting?: boolean;
  /** Loading states per path (vfs_abs_path) */
  loadingPaths: Set<string>;
}

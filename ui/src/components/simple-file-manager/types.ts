import { FSEntry, TypeId } from '@sdk';
import { FilterDefinition, FilterName } from './filters';

export interface FileItem {
  id: string;
  name: string;
  type: 'file' | 'folder';
  size: number;
  modifiedAt: Date;
  path: string;
  fsItem?: FSEntry;
}

export interface FilterConfig {
  /** Unique filter identifier */
  id: string;
  /** Display label for the filter */
  label: string;
  /** Whether this filter is currently enabled */
  enabled: boolean;
  /** Filter function - returns true to show item, false to hide */
  filterFn: (item: FileItem) => boolean;
}

export interface SimpleFileManagerProps {
  /** TypeId for the entity whose filesystem we're browsing */
  typeId: TypeId;
  /** Initial path to navigate to */
  initialPath?: string;
  /** Callback when a file is selected (double-clicked) */
  onFileSelect?: (path: string) => void;
  /** Callback when path changes */
  onPathChange?: (path: string) => void;
  /** Filter definitions for file filters component */
  filterDefinitions?: FilterDefinition[];
  /** Currently enabled filter names */
  enabledFilters?: FilterName[];
  /** Callback when enabled filters change - emits array of filter names */
  onEnabledFiltersChange?: (enabledFilters: FilterName[]) => void;
  /** Compact mode - hides size/modified columns and table header */
  compact?: boolean;
  /** Custom class name */
  className?: string;
  /** Called after a filesystem mutation (create/delete/rename/move/upload) with
   *  the affected parent folder's path, so the host can refresh its own tree
   *  (e.g. the Explorer navigator's `refreshNode`). */
  onFsMutated?: (parentRelPath: string) => void;
  /** Row-highlight predicate (absolute node path + is-dir). Rows matching it
   *  render in the highlight color — used by the git-backed context-folder
   *  browser to mark files not yet pushed to the remote. */
  isPathHighlighted?: (path: string, isDir: boolean) => boolean;
}

export type SortField = 'name' | 'size' | 'modifiedAt' | 'type';
export type SortDirection = 'asc' | 'desc';

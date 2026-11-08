import { FSEntry } from '@sdk';
import { create } from 'zustand';
import { FileItem, SortDirection, SortField } from './types';

/**
 * Per-folder view memory shared by the file browser and the file viewer:
 * the browser's sort, and the file the viewer last showed. The viewer pages
 * through media in the browser's order, and the browser selects what the
 * viewer showed. Keyed by the folder's path.
 */
export interface FolderSort {
  field: SortField;
  direction: SortDirection;
}

interface FolderView {
  sort?: FolderSort;
  shown?: string;
}

interface FolderViewState {
  folders: Record<string, FolderView>;
  setSort: (folder: string, sort: FolderSort) => void;
  setShown: (folder: string, name: string) => void;
}

export const DEFAULT_SORT: FolderSort = { field: 'name', direction: 'asc' };

export const useFolderViewStore = create<FolderViewState>((set) => {
  const patch = (folder: string, change: FolderView) =>
    set((s) => {
      const cur = s.folders[folder];
      if (cur && Object.entries(change).every(([k, v]) => cur[k as keyof FolderView] === v)) return s;
      return { folders: { ...s.folders, [folder]: { ...cur, ...change } } };
    });
  return {
    folders: {},
    setSort: (folder, sort) => patch(folder, { sort }),
    setShown: (folder, shown) => patch(folder, { shown }),
  };
});

/** The browser's folder key: leading slash, no trailing or doubled slashes. */
export function normalizeFsPath(path: string): string {
  if (!path) return '/';
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  return withLeadingSlash.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

/** Folder of a path, keyed the way the browser keys it. */
export function folderOf(path: string): string {
  return normalizeFsPath(path.slice(0, path.lastIndexOf('/')));
}

export function fsItemToFileItem(fsItem: FSEntry, currentPath: string): FileItem {
  const name = fsItem.relativePath?.split('/').pop() || fsItem.name || '';
  // Use relativePath for the full path, fallback to constructed path if relativePath is not available
  const itemPath = fsItem.relativePath || (currentPath === '/' ? `/${name}` : `${currentPath}/${name}`);
  return {
    id: fsItem.relativePath || name,
    name,
    type: fsItem.is_dir ? 'folder' : 'file',
    size: fsItem.size || 0,
    modifiedAt: fsItem.last_modified ? new Date(fsItem.last_modified * 1000) : new Date(),
    path: itemPath,
    fsItem,
  };
}

/** The browser's row order: folders first, then the chosen field. */
export function sortFileItems(items: FileItem[], { field, direction }: FolderSort): FileItem[] {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    let c = 0;
    if (field === 'size') c = a.size - b.size;
    else if (field === 'modifiedAt') c = a.modifiedAt.getTime() - b.modifiedAt.getTime();
    else c = a.name.localeCompare(b.name);
    return direction === 'asc' ? c : -c;
  });
}

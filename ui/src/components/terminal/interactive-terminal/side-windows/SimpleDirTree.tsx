import { type TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  Archive,
  CornerLeftUp,
  ExternalLink,
  File as FileIcon,
  FileCode,
  FileText,
  Folder,
  FolderSearch,
  Image,
  RefreshCw,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@src/components/ui/button';
import { useFS } from '@src/hooks/useFS';

interface SimpleDirTreeProps {
  computeNodeTypeId: TypeId;
  /** Highest level the user can navigate up to. ".." is hidden when at this path. */
  topLevel: string;
  /** Initial directory to show. Defaults to topLevel. Must be at or under topLevel. */
  initialPath?: string;
  onSelectFile?: (absPath: string) => void;
}

interface PathAsset {
  id: string;
  type: string;
  name: string;
  asset_ref: string;
  scope?: string;
  modified_at?: string;
}

const ASSET_RECORD_TYPES = [
  'skill',
  'agent',
  'workflow',
  'markdown',
  'claude_md',
  'claude_memory',
  'claude_rules',
  'command',
  'plan',
];

const TEXT_EXTENSIONS = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'ini', 'csv', 'log']);

const CODE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'go',
  'h',
  'html',
  'java',
  'js',
  'jsx',
  'kt',
  'mjs',
  'php',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'swift',
  'ts',
  'tsx',
  'vue',
]);

const IMAGE_EXTENSIONS = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const ARCHIVE_EXTENSIONS = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip']);

function normalize(path: string): string {
  if (!path) return '/';
  const collapsed = path.replace(/\/+/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.replace(/\/$/, '');
}

function parentOf(path: string): string {
  const normalized = normalize(path);
  if (normalized === '/') return '/';
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx);
}

function joinPath(dir: string, name: string): string {
  const base = normalize(dir);
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function defaultIconForItem(item: { name: string; is_dir?: boolean }) {
  if (item.is_dir) return Folder;
  const ext = extensionOf(item.name);
  if (TEXT_EXTENSIONS.has(ext)) return FileText;
  if (CODE_EXTENSIONS.has(ext)) return FileCode;
  if (IMAGE_EXTENSIONS.has(ext)) return Image;
  if (ARCHIVE_EXTENSIONS.has(ext)) return Archive;
  return FileIcon;
}

function toVfsPath(typeId: TypeId, absPath: string): string {
  const normalizedPath = normalize(absPath);
  if (normalizedPath === '/') return `${typeId.toString()}/`;
  return `${typeId.toString()}/${normalizedPath.replace(/^\/+/, '')}`;
}

export const SimpleDirTree: React.FC<SimpleDirTreeProps> = ({
  computeNodeTypeId,
  topLevel,
  initialPath,
  onSelectFile,
}) => {
  const fs = useFS(computeNodeTypeId);
  const { navigation } = useDockNavigation();
  const fsRef = React.useRef(fs);
  fsRef.current = fs;

  const normalizedTop = useMemo(() => normalize(topLevel), [topLevel]);
  const [currentPath, setCurrentPath] = useState<string>(() => normalize(initialPath ?? topLevel));
  const [assetRefreshKey, setAssetRefreshKey] = useState(0);
  const [pathAssets, setPathAssets] = useState<PathAsset[]>([]);
  const [filterQuery, setFilterQuery] = useState('');

  // Reset filter when navigating between directories — a query that fit the
  // old listing rarely fits the next one, and a stale filter that hides
  // every entry looks like the panel is broken.
  useEffect(() => { setFilterQuery(''); }, [currentPath]);

  const atTop = currentPath === normalizedTop;
  const browseResult = fs?.browse(currentPath);
  const items = useMemo(() => browseResult?.items ?? [], [browseResult?.items]);

  // Fetch on first visit to a path (cache-miss). listDirectory dedupes
  // concurrent calls, so spurious fires are cheap.
  useEffect(() => {
    if (browseResult) return;
    void fsRef.current?.listDirectory(currentPath);
  }, [browseResult, currentPath]);

  // Asset-record-type glyphs come from the bootstrap-loaded SchemaRegistry
  // (iconForType) — no per-type /assets/types fetch needed.

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    params.set('folder', currentPath);
    for (const type of ASSET_RECORD_TYPES) {
      params.append('record_type', type);
    }
    params.set('include_system', 'true');
    params.set('limit', '2000');

    apiClient
      .get(`/assets/by-path?${params.toString()}`)
      .then((data: unknown) => {
        if (cancelled) return;
        const d = data as { entities?: PathAsset[] } | null;
        setPathAssets(d?.entities ?? []);
      })
      .catch(() => {
        if (!cancelled) setPathAssets([]);
      });

    return () => {
      cancelled = true;
    };
  }, [assetRefreshKey, currentPath]);

  const assetByPath = useMemo(() => {
    const map = new Map<string, PathAsset>();
    for (const asset of pathAssets) {
      if (!asset.asset_ref) continue;
      map.set(normalize(asset.asset_ref), asset);
    }
    return map;
  }, [pathAssets]);

  const handleRefresh = useCallback(() => {
    fs?.invalidate(currentPath, 'browse');
    setAssetRefreshKey((value) => value + 1);
  }, [currentPath, fs]);

  const handleUp = useCallback(() => {
    if (atTop) return;
    setCurrentPath(parentOf(currentPath));
  }, [atTop, currentPath]);

  const handleOpenGenericFile = useCallback(
    (item: { name: string; vfs_abs_path?: string }) => {
      const childPath = joinPath(currentPath, item.name);
      const openPath = item.vfs_abs_path || toVfsPath(computeNodeTypeId, childPath);
      if (onSelectFile) {
        onSelectFile(openPath);
        return;
      }
      navigation.openEditor(openPath);
    },
    [computeNodeTypeId, currentPath, navigation, onSelectFile],
  );

  const handleOpenAsset = useCallback(
    (asset: PathAsset) => {
      if (!asset.asset_ref) return;
      navigation.openDock(DockPointer.forAssetEditor(asset.type, asset.asset_ref));
    },
    [navigation],
  );

  const handleOpenExternal = useCallback(
    async (path: string) => {
      try {
        await openExternalFromComputeNode(computeNodeTypeId.id, path);
      } catch (error) {
        console.error('[SimpleDirTree] Failed to open externally:', path, error);
      }
    },
    [computeNodeTypeId.id],
  );

  const handleRevealInFinder = useCallback(
    async (path: string) => {
      try {
        await openExternalFromComputeNode(computeNodeTypeId.id, path, { select: true });
      } catch (error) {
        console.error('[SimpleDirTree] Failed to reveal in file manager:', path, error);
      }
    },
    [computeNodeTypeId.id],
  );

  const handleEnter = useCallback(
    (item: { name: string; is_dir?: boolean; vfs_abs_path?: string }, asset?: PathAsset) => {
      const childPath = joinPath(currentPath, item.name);
      if (item.is_dir) {
        setCurrentPath(childPath);
      } else if (asset) {
        handleOpenAsset(asset);
      } else {
        handleOpenGenericFile(item);
      }
    },
    [currentPath, handleOpenAsset, handleOpenGenericFile],
  );

  const handleIconClick = useCallback(
    (item: { name: string; is_dir?: boolean; vfs_abs_path?: string }, asset?: PathAsset) => {
      if (asset) {
        handleOpenAsset(asset);
        return;
      }
      handleEnter(item);
    },
    [handleEnter, handleOpenAsset],
  );

  const renderItemIcon = useCallback(
    (item: { name: string; is_dir?: boolean }, asset?: PathAsset) => {
      const Icon = asset ? iconForType(asset.type) : defaultIconForItem(item);
      return <Icon className={`h-4 w-4 shrink-0 ${asset ? 'text-primary' : 'text-muted-foreground'}`} />;
    },
    [],
  );

  const sortedItems = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    const base = q ? items.filter((item) => item.name.toLowerCase().includes(q)) : items;
    return [...base].sort((a, b) => {
      const aDir = a.is_dir ? 0 : 1;
      const bDir = b.is_dir ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.name.localeCompare(b.name);
    });
  }, [items, filterQuery]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="truncate text-xs text-muted-foreground" title={currentPath}>
          {currentPath}
        </span>
        <Button variant="ghost" size="sm" onClick={handleRefresh} className="h-6 w-6 shrink-0 p-0">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="shrink-0 border-b px-2 py-1">
        <input
          type="text"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          placeholder="Filter…"
          className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
          aria-label="Filter files"
          data-testid="dir-tree-filter"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        <div className="flex flex-col">
          <button
            type="button"
            onClick={handleRefresh}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
            title="Current directory (click to refresh)"
          >
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="font-mono">.</span>
          </button>

          {!atTop && (
            <button
              type="button"
              onClick={handleUp}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-muted"
              title="Parent directory"
            >
              <CornerLeftUp className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="font-mono">..</span>
            </button>
          )}

          {sortedItems.map((item) => {
            const childPath = joinPath(currentPath, item.name);
            const asset = assetByPath.get(normalize(childPath));
            const iconTitle = asset ? `Open ${asset.type}: ${asset.name || item.name}\n${childPath}` : childPath;

            return (
              <div
                key={item.name}
                className="group flex items-center rounded-md text-sm hover:bg-muted"
                title={childPath}
              >
                <button
                  type="button"
                  onClick={() => handleIconClick(item, asset)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                  aria-label={iconTitle}
                  title={iconTitle}
                >
                  {renderItemIcon(item, asset)}
                </button>
                <button
                  type="button"
                  onClick={() => handleEnter(item, asset)}
                  className="min-w-0 flex-1 py-1 pr-2 text-left"
                >
                  <span className="block truncate">{item.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleRevealInFinder(childPath)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                  aria-label={`Reveal in Finder/Explorer: ${childPath}`}
                  title={`Reveal in Finder/Explorer\n${childPath}`}
                >
                  <FolderSearch className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleOpenExternal(childPath)}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                  aria-label={`Open externally: ${childPath}`}
                  title={`Open externally\n${childPath}`}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}

          {sortedItems.length === 0 && browseResult && (
            <p className="mt-4 px-2 text-center text-xs text-muted-foreground">
              {filterQuery.trim() ? 'no matches' : 'empty'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

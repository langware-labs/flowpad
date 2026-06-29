import { VFSPath } from '@sdk';
import { useViewerStore } from '@src/hooks/flow-hooks/useViewerStore';
import { FolderOpen } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { Trans } from '@lingui/react/macro';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { allScope, type ScopeFilter } from '@src/lib/scope-filter';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import { fsFolderNodeId, fsRootNodeId } from '@src/components/browseable-tree/adapters/fsFolderRoot';
import { FilterDefinition, FilterName, SimpleFileManager } from '../simple-file-manager';
import { useExplorerComputeNode } from './useExplorerComputeNode';
import './explorer-view.css';

function normalizeRelativePath(path: string | null | undefined): string {
  if (!path) return '';
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function joinRelativePath(base: string | null | undefined, sub: string | null | undefined): string {
  const normalizedBase = normalizeRelativePath(base);
  const normalizedSub = normalizeRelativePath(sub);
  if (!normalizedBase) return normalizedSub;
  if (!normalizedSub) return normalizedBase;
  return `${normalizedBase}/${normalizedSub}`;
}

export interface ExplorerViewProps {
  /** Filter definitions for file filters component */
  filterDefinitions?: FilterDefinition[];
  /** Currently enabled filter names */
  enabledFilters?: FilterName[];
  /** Callback when enabled filters change */
  onEnabledFiltersChange?: (enabledFilters: FilterName[]) => void;
  /** File selection handler - called when user double-clicks a file */
  onFileSelect: (path: string) => void;
  /** Compact mode - hides size/modified columns and table header */
  compact?: boolean;
}

/**
 * ExplorerView — the Explorer body (the folder table). The tree + scope filter
 * moved into the shared left menu (`ExplorerNavigator`); this view is now
 * URL-driven and table-only. The compute_node typeId + per-scope anchor come
 * from the shared `useExplorerComputeNode` hook so tree and table stay in sync.
 */
export function ExplorerView({
  filterDefinitions,
  enabledFilters,
  onEnabledFiltersChange,
  onFileSelect,
  compact = false,
}: ExplorerViewProps) {
  const { currentContext } = useViewerStore();
  const { currentDock, navigation } = useDockNavigation();
  const { typeId, anchorForScope, projectRootPath } = useExplorerComputeNode();

  const scope = useMemo<ScopeFilter>(() => currentDock?.scopeFilter ?? allScope(), [currentDock]);
  const anchorRel = useMemo(() => anchorForScope(scope), [anchorForScope, scope]);

  // Target path from the URL context. A `project`-typed pointer is remapped onto
  // the compute-node VFS; a stale compute_node id is ignored (only the subpath
  // matters — the live `typeId` does the listing).
  const targetPath = currentContext?.codeRef?.path;
  const vfsPath = useMemo(() => VFSPath.parse(targetPath), [targetPath]);
  const normalizedContextPath = useMemo(() => {
    if (!targetPath) return null;
    if (vfsPath.typeId) {
      if (vfsPath.typeId.type === 'project' && projectRootPath) {
        const mapped = joinRelativePath(projectRootPath, vfsPath.entitySubPath);
        return mapped ? `/${mapped}` : '/';
      }
      const rel = normalizeRelativePath(vfsPath.entitySubPath);
      return rel ? `/${rel}` : '/';
    }
    const normalized = targetPath.replace(/\\/g, '/').replace(/\/+/g, '/');
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }, [targetPath, vfsPath, projectRootPath]);

  // Unpointed scope lands on its anchor root.
  const computedDefaultPath = useMemo(() => {
    const a = normalizeRelativePath(anchorRel);
    return a ? `/${a}` : '/';
  }, [anchorRel]);

  const initialPath = useMemo(() => {
    if (normalizedContextPath) {
      const basePath = normalizedContextPath.startsWith('/')
        ? normalizedContextPath
        : `/${normalizedContextPath}`;
      const lastSlashIndex = basePath.lastIndexOf('/');
      const fileName = lastSlashIndex >= 0 ? basePath.substring(lastSlashIndex + 1) : basePath;
      if (fileName.includes('.')) {
        // It's a file - use its directory.
        return lastSlashIndex > 0 ? basePath.substring(0, lastSlashIndex) : computedDefaultPath;
      }
      return basePath;
    }
    return computedDefaultPath;
  }, [normalizedContextPath, computedDefaultPath]);

  // Table folder navigation is URL-first too: re-stamp the active scope so a
  // double-click into a subfolder keeps the filter.
  const handlePathChange = useCallback(
    (vfs: string) => {
      navigation.openDock(DockPointer.forExplorer(vfs).withScopeFilter(scope));
    },
    [navigation, scope],
  );

  // After a table mutation, poke the navigator's matching tree node so a new
  // folder/file shows without a full reload (the root for the anchor dir, a
  // folder node otherwise).
  const handleFsMutated = useCallback(
    (parentRel: string) => {
      if (!typeId) return;
      const rel = normalizeRelativePath(parentRel);
      const anchor = normalizeRelativePath(anchorRel);
      refreshNode(rel === anchor ? fsRootNodeId(typeId, anchor) : fsFolderNodeId(typeId, rel));
    },
    [typeId, anchorRel],
  );

  if (!typeId) {
    return (
      <div className="explorer-view-empty">
        <FolderOpen className="h-12 w-12 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground"><Trans>No project context available</Trans></p>
      </div>
    );
  }

  return (
    <div className="explorer-view-container">
      <SimpleFileManager
        typeId={typeId}
        initialPath={initialPath}
        onPathChange={handlePathChange}
        onFileSelect={onFileSelect}
        onFsMutated={handleFsMutated}
        filterDefinitions={filterDefinitions}
        enabledFilters={enabledFilters}
        onEnabledFiltersChange={onEnabledFiltersChange}
        compact={compact}
        className="h-full"
      />
    </div>
  );
}

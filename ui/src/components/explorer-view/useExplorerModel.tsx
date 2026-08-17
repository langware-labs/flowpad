import { useCallback, useMemo } from 'react';
import { HardDrive, User as UserIcon } from 'lucide-react';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { allScope, projectScope, userScope, type ScopeFilter } from '@src/lib/scope-filter';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { fsFolderRoot } from '@src/components/browseable-tree/adapters/fsFolderRoot';
import { contextFoldersRoot } from '@src/components/browseable-tree/adapters/contextFoldersRoot';
import type { BrowseableRoot } from '@src/components/browseable-tree/types';
import { useExplorerComputeNode } from './useExplorerComputeNode';

export type ExplorerScopeMode = 'all' | 'user' | 'project';

/** Explorer scope is one of three single-root anchors — collapse the unified
 *  ScopeFilter onto that (`filter` mode never occurs here). */
function explorerScopeMode(scope: ScopeFilter): ExplorerScopeMode {
  if (scope.mode === 'user') return 'user';
  if (scope.mode === 'project') return 'project';
  return 'all';
}

/**
 * useExplorerModel — the Explorer left-menu (navigator) model. URL-first: the
 * scope + anchor derive from `currentDock`; a scope toggle navigates (re-anchors
 * both tree and table); a row click re-stamps the active scope. Mirrors
 * `useAssetsModel`, but the tree is a single real-filesystem root (`fsFolderRoot`)
 * and the default scope is `all` (vs Assets' project default).
 */
export function useExplorerModel() {
  const { currentDock, navigation } = useDockNavigation();
  const { typeId, locatorTypeId, anchorForScope, projectRootPath, projectAvailable, projectId, projectName, contextDirs } =
    useExplorerComputeNode();

  const scope = useMemo<ScopeFilter>(() => currentDock?.scopeFilter ?? allScope(), [currentDock]);
  const scopeMode = explorerScopeMode(scope);
  const anchorRelPath = useMemo(() => anchorForScope(scope), [anchorForScope, scope]);

  const rootLabel = useMemo(() => {
    switch (scopeMode) {
      case 'user':
        return 'Home';
      case 'project':
        return projectName ?? 'Project';
      default:
        return 'Computer';
    }
  }, [scopeMode, projectName]);

  const rootIcon = useMemo(() => {
    switch (scopeMode) {
      case 'user':
        return <UserIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />;
      case 'project': {
        const ProjectIcon = iconForType('project');
        return <ProjectIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />;
      }
      default:
        return <HardDrive className="h-4 w-4 flex-shrink-0 text-muted-foreground" />;
    }
  }, [scopeMode]);

  const roots = useMemo<BrowseableRoot[]>(() => {
    if (!typeId || !locatorTypeId) return [];
    const list: BrowseableRoot[] = [
      fsFolderRoot({ typeId, locatorTypeId, anchorRelPath, scope, label: rootLabel, rootIcon, projectRootPath }),
    ];
    // Project context folders (include_dirs) get their own grouping root, shown
    // whenever the current project has any — browseable like any FS root.
    if (contextDirs.length > 0) {
      list.push(contextFoldersRoot({ typeId, locatorTypeId, scope, dirs: contextDirs }));
    }
    return list;
  }, [typeId, locatorTypeId, anchorRelPath, scope, rootLabel, rootIcon, projectRootPath, contextDirs]);

  const activePointer = currentDock ?? null;

  // Row click → navigate, re-stamping the active scope so the filter survives.
  const navigate = useCallback(
    (p: DockPointer) => {
      navigation.openDock(p.withScopeFilter(scope));
    },
    [navigation, scope],
  );

  // Scope toggle → re-anchor BOTH tree and table at the new scope's root.
  const handleScopeChange = useCallback(
    (next: ScopeFilter) => {
      if (!locatorTypeId) return;
      const newAnchor = anchorForScope(next);
      const path = newAnchor ? `${locatorTypeId.toString()}/${newAnchor}` : `${locatorTypeId.toString()}/`;
      navigation.openDock(DockPointer.forExplorer(path).withScopeFilter(next));
    },
    [locatorTypeId, anchorForScope, navigation],
  );

  const handleSelectMode = useCallback(
    (mode: ExplorerScopeMode) => {
      if (mode === 'user') handleScopeChange(userScope());
      else if (mode === 'project') {
        if (projectId) handleScopeChange(projectScope(projectId));
      } else handleScopeChange(allScope());
    },
    [handleScopeChange, projectId],
  );

  return {
    roots,
    activePointer,
    navigate,
    scopeMode,
    handleSelectMode,
    projectDisabled: !projectAvailable,
    projectName,
  } as const;
}

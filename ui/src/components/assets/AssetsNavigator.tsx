import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { AssetTypeCountsContext } from '@src/components/browseable-tree/adapters/assetTypeRoot';
import { ScopeFilterIconBar } from '@src/components/scope-filter/ScopeFilterIconBar';
import { useAssetsModel } from './useAssetsModel';
import { useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';
import { NewOfTypeDialog } from '@src/components/quick-create';

/**
 * Assets left-menu — the navigator (Zone B). The tree (asset types + markdown
 * folders), scope filter, counts, and create/new-folder/move handlers live in
 * `useAssetsModel`; the body (`AssetsPage`) keeps the header + content router.
 */
export function AssetsNavigator() {
  const { t } = useLingui();
  const m = useAssetsModel();

  // Stable identity for the search context (the asset types the menu lists), so
  // the descriptor's fresh-each-render literal doesn't churn the search hooks.
  const searchRecordTypes = useMemo(() => Array.from(m.typeCounts.keys()), [m.typeCounts]);

  // Not memoized: `useAssetsModel` returns a fresh object each render, so a memo
  // keyed on it would never hit. NavigatorPanel doesn't depend on descriptor
  // identity (it rebuilds the tree each render; BrowseableTree memoizes itself).
  const descriptor: NavigatorDescriptor = {
    id: 'assets',
    roots: m.roots,
    isLoading: m.menuLoading,
    activePointer: m.treeActivePointer,
    activeResourcePointer: m.treeActiveResourcePointer,
    activeKey: m.openAssetId,
    onNavigate: m.navigateAsset,
    bulkActions: m.bulkActions,
    search: {
      recordTypes: searchRecordTypes,
      scope: m.scope,
      placeholder: t`Search assets…`,
    },
    header: {
      title: m.isProjectView ? t`Project assets` : t`Assets`,
      headerRight: (
        <ScopeFilterIconBar
          scope={m.scope}
          currentProjectId={m.scopeProjectId}
          currentProjectName={m.scopeProjectName}
          onScopeChange={m.handleScopeChange}
          showDependencies
        />
      ),
    },
    wrapTree: (tree) => <AssetTypeCountsContext.Provider value={m.typeCounts}>
      {m.menuError && <div role="alert">
        <button type="button" onClick={m.reloadMenu} className="p-2 text-xs text-destructive">
          {t`Assets unavailable. Retry`}
        </button>
      </div>}
      {tree}
    </AssetTypeCountsContext.Provider>,
  };

  return (
    <>
      <NavigatorPanel descriptor={descriptor} legacyKeys={{ width: 'wiki:sidebar-width' }} />
      <NewOfTypeDialog
        type={m.newTypeTarget}
        open={m.newTypeDialogOpen}
        onOpenChange={m.setNewTypeDialogOpen}
        projectId={m.scope.mode === 'user' ? null : (m.scopeProjectId ?? null)}
        onConfirmName={(name) => void m.handleNewConfirm(name)}
      />
      {m.dependencyDialogs}
      {m.fileOpsDialogs}
    </>
  );
}

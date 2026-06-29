import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';
import type { NavigatorDescriptor } from '@src/components/navigator-panel/types';
import { AssetTypeCountsContext } from '@src/components/browseable-tree/adapters/assetTypeRoot';
import { ScopeFilterIconBar } from '@src/components/scope-filter/ScopeFilterIconBar';
import { InputDialog } from '@src/components/ui/input-dialog';
import { useAssetsModel } from './useAssetsModel';

/**
 * Assets left-menu — the navigator (Zone B). The tree (asset types + markdown
 * folders), scope filter, counts, and create/new-folder/move handlers live in
 * `useAssetsModel`; the body (`AssetsPage`) keeps the header + content router.
 */
export function AssetsNavigator() {
  const m = useAssetsModel();

  // Not memoized: `useAssetsModel` returns a fresh object each render, so a memo
  // keyed on it would never hit. NavigatorPanel doesn't depend on descriptor
  // identity (it rebuilds the tree each render; BrowseableTree memoizes itself).
  const descriptor: NavigatorDescriptor = {
    id: 'assets',
    roots: m.roots,
    isLoading: m.typesLoading && m.roots.length === 0,
    activePointer: m.treeActivePointer,
    activeKey: m.openAssetId,
    onNavigate: m.navigateAsset,
    header: {
      title: m.isProjectView ? 'Project assets' : 'Assets',
      headerRight: (
        <ScopeFilterIconBar
          scope={m.scope}
          currentProjectId={m.scopeProjectId}
          currentProjectName={m.scopeProjectName}
          onScopeChange={m.handleScopeChange}
        />
      ),
    },
    wrapTree: (tree) => (
      <AssetTypeCountsContext.Provider value={m.typeCounts}>{tree}</AssetTypeCountsContext.Provider>
    ),
  };

  return (
    <>
      <NavigatorPanel descriptor={descriptor} legacyKeys={{ width: 'wiki:sidebar-width' }} />
      <InputDialog
        open={m.newTypeDialogOpen}
        onOpenChange={m.setNewTypeDialogOpen}
        title={`New ${m.newTypeTarget ?? ''}`}
        description={`Enter a name for the new ${m.newTypeTarget ?? 'item'}.`}
        placeholder="Name"
        confirmLabel="Create"
        onConfirm={(name) => void m.handleNewConfirm(name)}
      />
      <InputDialog
        open={m.newFolderDialogOpen}
        onOpenChange={m.setNewFolderDialogOpen}
        title="New Folder"
        description={`Create a folder in ${m.newFolderTarget?.label ?? 'this folder'}.`}
        placeholder="Folder name"
        confirmLabel="Create"
        onConfirm={(name) => void m.handleNewFolderConfirm(name)}
      />
    </>
  );
}

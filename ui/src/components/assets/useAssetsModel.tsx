import { useCallback, useMemo, useState } from 'react';
import { Link, Trash2 } from 'lucide-react';
import {
  AssetDocPointer,
} from '@src/navigation/AssetDocPointer';
import { AssetEditor, AssetMode, AssetRoutingMethod } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dataContext, fsManager, fsStore, RecordType, TypeId, VFSPath } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ViewType } from '@src/types/ViewType';
import { notify } from '@src/notifications';
import { getDescriptor } from '@src/components/quick-create';
import { useAssetStats } from '@src/hooks/use-asset-stats';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useAssetTreeRefresh } from '@src/hooks/useAssetTreeRefresh';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { assetScopeBucket, defaultScopeFilter, scopeFilterKey, unionAssetBucket } from '@src/lib/scope-filter';
import type { AssetScopeBucket, ScopeFilter } from '@src/lib/scope-filter';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { assetTypeRoot } from '@src/components/browseable-tree/adapters/assetTypeRoot';
import {
  markdownFolderNodeId,
  markdownFolderRoot,
  type MarkdownDragItem,
  type MarkdownFolderTarget,
} from '@src/components/browseable-tree/adapters/markdownFolderRoot';
import type { Browseable, BrowseableRoot } from '@src/components/browseable-tree/types';
import type { MultiSelectAction } from '@src/components/navigator-panel/types';
import type { AssetFilter } from './assetFilter';
import { DEFAULT_ASSET_FILTER } from './assetFilter';

const HIDDEN_TYPES = new Set<string>([RecordType.ANNOTATION, RecordType.PROJECT]);

// --- path helpers (mirrors AssetsPage; pure) -------------------------------
function normalizeTreePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}
function basenamePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
function dirnamePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return '';
  if (idx === 0) return '/';
  return trimmed.slice(0, idx);
}
function parseAssetEditorPointer(pointer: string | undefined): { typeName: string; absPath: string } | null {
  if (!pointer?.startsWith('editor/')) return null;
  let ptr: AssetDocPointer;
  try {
    ptr = AssetDocPointer.parse(pointer);
  } catch {
    return null;
  }
  if (ptr.mode !== AssetMode.EDITOR || ptr.method !== AssetRoutingMethod.VFS || !ptr.editor) return null;
  const vfs = VFSPath.parse(ptr.value);
  return { typeName: ptr.editor, absPath: `/${vfs.entitySubPath.replace(/^\/+/, '')}` };
}
function joinRelPath(parent: string, name: string): string {
  const base = normalizeTreePath(parent);
  const cleanName = name.replace(/^\/+/, '').replace(/\/+$/, '');
  return base ? `${base}/${cleanName}` : cleanName;
}
function joinAbsPath(parent: string, name: string): string {
  const base = parent.replace(/\/+$/, '');
  const cleanName = name.replace(/^\/+/, '').replace(/\/+$/, '');
  return base && base !== '/' ? `${base}/${cleanName}` : `/${cleanName}`;
}
function isValidFolderName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !/[\\/]/.test(name);
}

/**
 * useAssetsModel — the shared Assets left-menu (Zone B) model. Encapsulates the
 * URL-derived scope/selection state, the tree roots (asset types + markdown
 * folders), the per-type counts, and the create/new-folder/move handlers +
 * dialog state. Consumed by `AssetsNavigator`. Everything is URL-first;
 * `navigateAsset` re-stamps the active scope so the tab identity is unchanged.
 */
export function useAssetsModel() {
  const { currentDock, navigation } = useDockNavigation();
  const { types: allTypes, isLoading: typesLoading } = useAssetTypes();
  const { indexType } = useSystemTools();
  const [newTypeTarget, setNewTypeTarget] = useState<string | null>(null);
  const [newTypeDialogOpen, setNewTypeDialogOpen] = useState(false);
  const [newFolderTarget, setNewFolderTarget] = useState<MarkdownFolderTarget | null>(null);
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);

  const currentProjectId = dataContext.project?.id ?? null;
  const currentProjectName = dataContext.project?.getDisplayName() ?? dataContext.project?.name ?? null;

  const isProjectView = currentDock?.viewType === ViewType.PROJECT;
  const { projectId: urlProjectId, assetSubPointer } = isProjectView
    ? DockPointer.splitProjectPointer(currentDock?.pointer)
    : { projectId: null, assetSubPointer: currentDock?.pointer ?? '' };
  const scopeProjectId = urlProjectId ?? currentProjectId;
  const scopeProjectName = scopeProjectId === currentProjectId ? currentProjectName : null;
  const projectSeedScope = useMemo(
    () => (urlProjectId ? defaultScopeFilter(urlProjectId) : null),
    [urlProjectId],
  );
  const effectivePointer = isProjectView ? assetSubPointer : (currentDock?.pointer ?? '');

  const urlScope = useMemo<ScopeFilter>(
    () => currentDock?.scopeFilter ?? projectSeedScope ?? defaultScopeFilter(currentProjectId),
    [currentDock, projectSeedScope, currentProjectId],
  );

  const [assetFilter] = useState<AssetFilter>(() => ({ ...DEFAULT_ASSET_FILTER }));

  const openAssetTypeId = useMemo<TypeId | null>(() => {
    if (!effectivePointer.startsWith('editor/')) return null;
    try {
      const p = AssetDocPointer.parse(effectivePointer);
      if (p.editor !== AssetEditor.CODE && p.method === AssetRoutingMethod.TYPEID) {
        return new TypeId(p.value);
      }
    } catch {
      // not an editor/typeid pointer
    }
    return null;
  }, [effectivePointer]);
  const openAssetId = openAssetTypeId?.toString() ?? null;
  const { data: openAsset } = useEntity(openAssetTypeId);
  // Single typed view of the resolved entity's optional fs fields (the SDK
  // entity type is generic here); reused for scope-bucketing and tree addressing.
  const openAssetFields = openAsset as
    | { asset_ref?: string; scope?: string | null; project_id?: string | null }
    | null;
  const openAssetBucket = useMemo<AssetScopeBucket>(
    () => assetScopeBucket(openAssetFields),
    [openAsset],
  );
  const [suppressedAssetId, setSuppressedAssetId] = useState<string | null>(null);

  const effectiveFilter = useMemo<AssetFilter>(() => {
    const useBucket = openAssetBucket && openAssetId !== suppressedAssetId;
    const scope = useBucket ? unionAssetBucket(urlScope, openAssetBucket) : urlScope;
    return { ...assetFilter, scope };
  }, [assetFilter, urlScope, openAssetBucket, openAssetId, suppressedAssetId]);

  const { stats: assetStats } = useAssetStats(effectiveFilter.scope);
  const typeCounts = useMemo(
    () => new Map(Object.entries(assetStats.per_type)),
    [assetStats.per_type],
  );

  const visibleTypes = useMemo(() => allTypes.filter((t) => !HIDDEN_TYPES.has(t.type_name)), [allTypes]);

  // Reactivity only: keep each type's tree root live. A created / indexed /
  // scanned entity arrives as a `data_op`; this re-fetches the affected root
  // (and primes empty-at-mount roots) so the list never goes stale until a
  // manual refresh. See useAssetTreeRefresh.
  const visibleTypeNames = useMemo(() => visibleTypes.map((t) => t.type_name), [visibleTypes]);
  useAssetTreeRefresh(visibleTypeNames, effectiveFilter.scope);
  const creatableTypes = useMemo(
    () => new Set(allTypes.filter((t) => t.creatable).map((t) => t.type_name)),
    [allTypes],
  );

  const openScoped = useCallback(
    (scope: ScopeFilter) => {
      const base = currentDock ?? DockPointer.forAssetList('all');
      navigation.openDock(base.withScopeFilter(scope));
    },
    [currentDock, navigation],
  );

  const handleScopeChange = useCallback(
    (scope: ScopeFilter) => {
      openScoped(scope);
      setSuppressedAssetId(openAssetId);
    },
    [openScoped, openAssetId],
  );

  const navigateAsset = useCallback(
    (p: DockPointer) => {
      navigation.openDock(p.withScopeFilter(urlScope));
    },
    [navigation, urlScope],
  );

  // Multi-select toolbar resolver. Content adapts to the current selection: every
  // row that carries a `bulkDelete` (its adapter owns the actual delete) can be
  // deleted, while "Copy links" applies to entity rows only — so selecting a
  // skill-folder file vs. an agent surfaces a different toolbar. A bulk delete
  // shows ONE confirmation, deletes in parallel, then refreshes the distinct
  // owning nodes so removed rows drop out.
  const bulkActions = useCallback(
    (selected: Browseable[]): MultiSelectAction[] => {
      const deleteAction: MultiSelectAction = {
        id: 'delete',
        icon: <Trash2 />,
        label: selected.length > 1 ? `Delete ${selected.length}` : 'Delete',
        variant: 'destructive',
        run: (items, ctx) => {
          const deletable = items.filter((n) => n.bulkDelete);
          if (deletable.length === 0) return;
          showDeleteAssetModal({
            name: deletable.length > 1 ? `${deletable.length} items` : deletable[0]?.label ?? 'item',
            description:
              deletable.length > 1
                ? `This permanently deletes ${deletable.length} selected items. This cannot be undone.`
                : undefined,
            onConfirm: async () => {
              await Promise.all(deletable.map((n) => n.bulkDelete!.run()));
            },
            onAfterDelete: () => {
              const ids = new Set(deletable.map((n) => n.bulkDelete!.refreshId));
              if (ctx.scopeRootId) ids.add(ctx.scopeRootId);
              ids.forEach((nodeId) => refreshNode(nodeId));
              ctx.clearSelection();
            },
          });
        },
      };

      const copyLinksAction: MultiSelectAction = {
        id: 'copy-links',
        icon: <Link />,
        label: 'Copy links',
        // Entity rows only — folder files have no shareable deep link.
        enabledWhen: (items) => items.length > 0 && items.every((n) => n.selectionType !== 'file'),
        run: async (items, ctx) => {
          const urls = items
            .map((n) => (n.pointer ? navigation.getDockUrl(n.pointer) : null))
            .filter((u): u is string => !!u);
          if (urls.length === 0) return;
          try {
            await navigator.clipboard.writeText(urls.join('\n'));
            notify.success({ title: `Copied ${urls.length} link${urls.length > 1 ? 's' : ''}` });
          } catch {
            notify.error({ title: 'Failed to copy links' });
          }
          ctx.clearSelection();
        },
      };

      return [copyLinksAction, deleteAction];
    },
    [navigation],
  );

  const treeActivePointer = useMemo<DockPointer | null>(() => {
    if (isProjectView) {
      // The sidebar tree (markdown folder tree especially) is vfs-keyed, but an
      // asset editor URL addresses the doc by its stable typeid
      // (`editor/<t>/typeid/<id>`). Once the open entity is resolved, re-address
      // it to the tree by its vfs `asset_ref` so the (vfs) tree can auto-expand
      // + highlight it via its existing path resolution. Falls back to the raw
      // pointer until the entity resolves (or for non-typeid/vfs pointers).
      const assetRef = openAssetFields?.asset_ref;
      if (assetRef && openAssetTypeId) {
        // forAssetEditor already returns a ViewType.ASSETS editor pointer.
        return DockPointer.forAssetEditor(openAssetTypeId.type, assetRef);
      }
      return new DockPointer(ViewType.ASSETS, effectivePointer || undefined);
    }
    return currentDock ?? null;
  }, [isProjectView, effectivePointer, currentDock, openAsset, openAssetTypeId]);

  const handleNew = useCallback((type: string) => {
    setNewTypeTarget(type);
    setNewTypeDialogOpen(true);
  }, []);

  const handleCreateFolder = useCallback((target: MarkdownFolderTarget) => {
    setNewFolderTarget(target);
    setNewFolderDialogOpen(true);
  }, []);

  const handleNewFolderConfirm = useCallback(
    async (rawName: string) => {
      const name = rawName.trim();
      if (!newFolderTarget || !isValidFolderName(name)) {
        notify.error({ title: 'Invalid folder name' });
        return;
      }
      const typeId = new TypeId(newFolderTarget.typeid);
      const folderRelPath = joinRelPath(newFolderTarget.relPath, name);
      try {
        if (await fsManager.exists(typeId, folderRelPath)) {
          notify.error({ title: 'Folder already exists' });
          return;
        }
        await fsManager.mkdir(typeId, folderRelPath);
        fsStore.getState().invalidate(typeId, newFolderTarget.relPath || '/', 'browse');
        refreshNode(markdownFolderNodeId(newFolderTarget.typeid, newFolderTarget.absPath));
        notify.success({ title: 'Folder created' });
      } catch (err) {
        console.error('[AssetsNavigator] Failed to create folder:', err);
        notify.error({ title: 'Failed to create folder' });
      } finally {
        setNewFolderTarget(null);
      }
    },
    [newFolderTarget],
  );

  const handleNewConfirm = useCallback(
    async (name: string) => {
      if (!name.trim() || !newTypeTarget) return;
      const descriptor = getDescriptor(newTypeTarget);
      if (!descriptor) {
        notify.error({ title: `Cannot create ${newTypeTarget}` });
        setNewTypeTarget(null);
        return;
      }
      try {
        // Place the new asset per the SELECTED scope, not the ambient active
        // project. In user scope the create must be user-level (project=null) —
        // otherwise it POSTs to /graph/project/<active>/skill, lands in that
        // project's folder, and (now that scope follows project_id) is tagged
        // `project`, so a user-scope create wrongly shows up under a project.
        const createProject = effectiveFilter.scope.mode === 'user' ? null : (dataContext.project ?? null);
        const res = await descriptor.create({ project: createProject, name });
        notify.success({ title: res.toastTitle });
        // Local create: poke this type's tree root so the new entity shows
        // immediately. The useAssetTreeRefresh subscription also covers it
        // (and remote/async creates), but the explicit poke avoids waiting on
        // the data_op echo — mirroring the delete path.
        refreshNode(`asset-type:${newTypeTarget}:${scopeFilterKey(effectiveFilter.scope)}`);
        if (res.pointer) {
          navigateAsset(res.pointer);
          setNewTypeTarget(null);
          return;
        }
      } catch (err) {
        console.error('[AssetsNavigator] Failed to create:', err);
        notify.error({ title: 'Failed to create' });
      }
      setNewTypeTarget(null);
    },
    [newTypeTarget, navigateAsset, effectiveFilter.scope],
  );

  const handleMoveMarkdownItem = useCallback(
    async (item: MarkdownDragItem, target: MarkdownFolderTarget) => {
      const name = basenamePath(item.relPath) || item.label;
      if (!name) return;
      const typeId = new TypeId(item.typeid);
      const sourceRel = normalizeTreePath(item.relPath);
      const destRel = joinRelPath(target.relPath, name);
      const destAbs = joinAbsPath(target.absPath, name);
      const sourceParentRel = dirnamePath(sourceRel);
      const sourceParentAbs = dirnamePath(item.absPath);
      if (sourceRel === destRel) return;
      try {
        if (await fsManager.exists(typeId, destRel)) {
          notify.error({ title: 'Destination already has an item with that name' });
          return;
        }
        await fsManager.move(typeId, sourceRel, destRel);
        const store = fsStore.getState();
        store.invalidate(typeId, sourceRel, 'all');
        store.invalidate(typeId, destRel, 'all');
        store.invalidate(typeId, sourceParentRel || '/', 'browse');
        store.invalidate(typeId, target.relPath || '/', 'browse');
        refreshNode(markdownFolderNodeId(item.typeid, sourceParentAbs));
        refreshNode(markdownFolderNodeId(item.typeid, target.absPath));

        const activeEditor = parseAssetEditorPointer(effectivePointer);
        const sourceAbs = item.absPath.replace(/\/+$/, '');
        const activeEditorInMovedFolder = !!(
          activeEditor &&
          item.kind === 'markdown-folder' &&
          activeEditor.typeName === item.typeName &&
          activeEditor.absPath.startsWith(`${sourceAbs}/`)
        );
        if (activeEditor?.typeName === item.typeName && activeEditor.absPath === sourceAbs) {
          navigateAsset(DockPointer.forAssetEditor(item.typeName, destAbs));
        } else if (activeEditorInMovedFolder && activeEditor) {
          const suffix = activeEditor.absPath.slice(sourceAbs.length).replace(/^\/+/, '');
          const nextAbs = suffix ? `${destAbs}/${suffix}` : destAbs;
          navigateAsset(DockPointer.forAssetEditor(item.typeName, nextAbs));
        } else if (item.kind === 'markdown-folder' && effectivePointer) {
          const folder = DockPointer.parseAssetFolderPointer(effectivePointer);
          if (folder && folder.typeName === item.typeName && folder.typeid === item.typeid) {
            const currentRel = normalizeTreePath(folder.relPath);
            if (currentRel === sourceRel || currentRel.startsWith(`${sourceRel}/`)) {
              const suffix = currentRel.slice(sourceRel.length).replace(/^\/+/, '');
              const nextRel = suffix ? `${destRel}/${suffix}` : destRel;
              navigateAsset(DockPointer.forAssetFolder(item.typeName, item.typeid, nextRel));
            }
          }
        }

        try {
          await indexType('markdown', effectiveFilter.scope, { force: true });
        } catch (err) {
          console.error('[AssetsNavigator] Markdown reindex after move failed:', err);
          notify.error({ title: 'Moved, but reindex failed' });
          return;
        }
        notify.success({ title: 'Moved' });
      } catch (err) {
        console.error('[AssetsNavigator] Failed to move markdown item:', err);
        notify.error({ title: 'Failed to move item' });
      }
    },
    [effectiveFilter.scope, effectivePointer, indexType, navigateAsset],
  );

  const roots = useMemo<BrowseableRoot[]>(
    () =>
      visibleTypes.map((t) => {
        if (t.type_name === 'markdown') {
          return markdownFolderRoot(t, {
            indexType,
            onNew: handleNew,
            onCreateFolder: handleCreateFolder,
            onMoveItem: handleMoveMarkdownItem,
            filter: effectiveFilter,
            onOpenKnowledgeBrowser: (absPath) =>
              navigation.openDock(DockPointer.forKnowledgeBrowser(absPath, 'vfs')),
          });
        }
        return assetTypeRoot(t, {
          indexType,
          onNew: handleNew,
          creatableTypes,
          filter: effectiveFilter,
        });
      }),
    [
      visibleTypes,
      indexType,
      handleNew,
      handleCreateFolder,
      handleMoveMarkdownItem,
      creatableTypes,
      effectiveFilter,
      navigation,
    ],
  );

  return {
    roots,
    treeActivePointer,
    openAssetId,
    typesLoading,
    typeCounts,
    isProjectView,
    // scope bar
    scope: effectiveFilter.scope,
    scopeProjectId,
    scopeProjectName,
    handleScopeChange,
    navigateAsset,
    bulkActions,
    // dialogs
    newTypeTarget,
    newTypeDialogOpen,
    setNewTypeDialogOpen,
    handleNewConfirm,
    newFolderTarget,
    newFolderDialogOpen,
    setNewFolderDialogOpen,
    handleNewFolderConfirm,
  } as const;
}

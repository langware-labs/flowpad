import { useCallback, useMemo, useState } from 'react';
import { Home, Link, Trash2 } from 'lucide-react';
import {
  AssetDocPointer,
} from '@src/navigation/AssetDocPointer';
import { AssetEditor, AssetMode, AssetRoutingMethod } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dataContext, fsManager, fsStore, Project, RecordType, TypeId, VFSPath } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ViewType } from '@src/types/ViewType';
import { notify } from '@src/notifications';
import { getDescriptor } from '@src/components/quick-create';
import { useAssetStats } from '@src/hooks/use-asset-stats';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useAssetTreeRefresh } from '@src/hooks/useAssetTreeRefresh';
import { useProjectContextFolders } from '@src/hooks/use-project-context-folders';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { useIsDev } from '@src/contexts/view-mode-context';
import { assetScopeBucket, defaultScopeFilter, projectScope, scopeFilterKey, unionAssetBucket } from '@src/lib/scope-filter';
import type { AssetScopeBucket, ScopeFilter } from '@src/lib/scope-filter';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { assetTypeRoot } from '@src/components/browseable-tree/adapters/assetTypeRoot';
import { assetContextFoldersRoot } from '@src/components/browseable-tree/adapters/assetContextFoldersRoot';
import { flatEntityRoots } from '@src/components/browseable-tree/adapters/flatEntityRoot';
import { normalizeRel } from '@src/components/browseable-tree/adapters/fsFolderRoot';
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
  const { types: allTypes, isLoading: typesLoading } = useAssetTypes({ vibeAsStandard: true });
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
  const projectSeedScope = useMemo(
    () => (urlProjectId ? defaultScopeFilter(urlProjectId) : null),
    [urlProjectId],
  );
  const effectivePointer = isProjectView ? assetSubPointer : (currentDock?.pointer ?? '');

  const urlScope = useMemo<ScopeFilter>(
    () => currentDock?.scopeFilter ?? projectSeedScope ?? defaultScopeFilter(currentProjectId),
    [currentDock, projectSeedScope, currentProjectId],
  );
  const scopeProjectId =
    urlProjectId ?? (urlScope.mode === 'project' ? urlScope.activeProjectId ?? null : currentProjectId);
  const scopeProjectName = scopeProjectId === currentProjectId ? currentProjectName : null;

  // The scoped project entity, watched so `include_dirs` edits (add/remove
  // context folder) re-render the tree. Backs the "Context folders" root.
  const scopeProjectTypeId = useMemo(
    () => (scopeProjectId ? new TypeId(Project.type, scopeProjectId) : null),
    [scopeProjectId],
  );
  const { data: scopeProject } = useEntity<Project>(scopeProjectTypeId, {
    watch: true,
    enabled: !!scopeProjectTypeId,
  });
  const hasScopeProject = !!scopeProject;
  const {
    contextDirs,
    addPaths: handleAddContextPaths,
    pickAndAdd: handleBrowseContextDir,
    remove: removeContextDir,
  } = useProjectContextFolders(scopeProject);

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

  const { stats: assetStats, isLoading: statsLoading } = useAssetStats(effectiveFilter.scope);
  const typeCounts = useMemo(
    () => new Map(Object.entries(assetStats.per_type)),
    [assetStats.per_type],
  );

  // Dev mode sees every registered type regardless of count; everyone else only
  // sees types that actually have items in the current scope.
  const isDev = useIsDev();

  const visibleTypes = useMemo(() => allTypes.filter((t) => !HIDDEN_TYPES.has(t.type_name)), [allTypes]);

  // The set of type names the menu lists, as a stable string key. Non-dev: hide
  // empty types once counts are in. First load (`statsLoading`, no cached counts)
  // → empty, so the navigator shows its "Loading…" state; then the list collapses
  // to the types with content. `null` = dev (show all). Keying on the *set* (not
  // the count values) means a count changing 3→4 doesn't churn `displayTypes` /
  // `roots` — only a type appearing/disappearing does.
  const shownTypesKey = useMemo(() => {
    if (isDev) return null;
    if (statsLoading) return '';
    return visibleTypes
      .filter((t) => (typeCounts.get(t.type_name) ?? 0) > 0)
      .map((t) => t.type_name)
      .join(',');
  }, [isDev, statsLoading, visibleTypes, typeCounts]);

  // The types the menu actually lists. Derived purely from `shownTypesKey` +
  // `visibleTypes`, so its array identity is stable while the shown set is.
  const displayTypes = useMemo(() => {
    if (shownTypesKey === null) return visibleTypes; // dev: all
    if (shownTypesKey === '') return []; // loading, or genuinely nothing to show
    const shown = new Set(shownTypesKey.split(','));
    return visibleTypes.filter((t) => shown.has(t.type_name));
  }, [shownTypesKey, visibleTypes]);

  // First-load spinner for the type list: true only until the first counts land
  // (react-query `isLoading` is first-load-only, so scope refetches with a warm
  // cache don't re-flash it). Dev mode never gates on counts.
  const menuLoading = typesLoading || (!isDev && statsLoading);

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
      const base = effectivePointer === AssetMode.PROJECT_HOME && scope.mode !== 'project'
        ? DockPointer.forAssetList('all')
        : (currentDock ?? DockPointer.forAssetList('all'));
      navigation.openDock(base.withScopeFilter(scope));
    },
    [currentDock, effectivePointer, navigation],
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
      // Menu builders usually emit scope-less ASSETS pointers; stamp the active
      // URL scope so in-assets navigation keeps the same scope-keyed tab. A row
      // may intentionally carry its own scope (Project home), which wins.
      navigation.openDock(
        p.viewType === ViewType.ASSETS ? p.withScopeFilter(p.scopeFilter ?? urlScope) : p,
      );
    },
    [navigation, urlScope],
  );

  // ── Context folders (project include_dirs) ────────────────────────────────
  // Mutations live in the shared useProjectContextFolders hook (destructured
  // above); the watched entity re-renders the root's rows. The root's "+"
  // opens the source-chooser dialog (project folder / open folder), which
  // funnels back through handleAddContextPaths / handleBrowseContextDir.
  const [addContextFolderDialogOpen, setAddContextFolderDialogOpen] = useState(false);

  const handleRemoveContextDir = useCallback(
    async (dir: string) => {
      await removeContextDir(dir);
      // If the body is showing the removed folder (or a subfolder of it), fall
      // back to the plain asset list so the view isn't stranded.
      const rel = normalizeRel(DockPointer.parseAssetFsPointer(effectivePointer) ?? '');
      const removed = normalizeRel(dir);
      if (rel && removed && (rel === removed || rel.startsWith(`${removed}/`))) {
        navigateAsset(DockPointer.forAssetList('all'));
      }
    },
    [removeContextDir, effectivePointer, navigateAsset],
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
      // Bare project home (no asset sub-pointer) → address the project pointer so
      // the "Project home" top entry highlights (it owns exactly this pointer).
      if (!effectivePointer && scopeProjectId) {
        return DockPointer.forProject(scopeProjectId);
      }
      return new DockPointer(ViewType.ASSETS, effectivePointer || undefined);
    }
    return currentDock ?? null;
  }, [isProjectView, effectivePointer, scopeProjectId, currentDock, openAsset, openAssetTypeId]);

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

  const roots = useMemo<BrowseableRoot[]>(() => {
    const list: BrowseableRoot[] = [];
    // Special top entry: jump back to the selected project's home. In a project
    // route, keep the bare PROJECT pointer. In the Assets manager, use the
    // project-home asset sub-pointer so the landing opens in the same
    // scope-keyed Assets tab instead of minting a separate Project tab.
    if (scopeProjectId) {
      list.push(
        ...flatEntityRoots([
          {
            id: `project-home:${scopeProjectId}`,
            label: 'Project home',
            icon: <Home className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
            pointer: isProjectView
              ? DockPointer.forProject(scopeProjectId)
              : DockPointer.forAssetProjectHome({ scope: projectScope(scopeProjectId) }),
          },
        ]),
      );
    }
    list.push(...displayTypes.map((t) => {
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
    }));
    // Context folders (project include_dirs) — shown whenever a project is in
    // scope (even with no dirs yet, so the "+" add action is reachable).
    if (hasScopeProject) {
      list.push(
        assetContextFoldersRoot({
          dirs: contextDirs,
          onAdd: () => setAddContextFolderDialogOpen(true),
          onRemove: handleRemoveContextDir,
        }),
      );
    }
    return list;
  }, [
    displayTypes,
    indexType,
    handleNew,
    handleCreateFolder,
    handleMoveMarkdownItem,
    creatableTypes,
    effectiveFilter,
    navigation,
    isProjectView,
    scopeProjectId,
    hasScopeProject,
    contextDirs,
    handleRemoveContextDir,
  ]);

  return {
    roots,
    treeActivePointer,
    openAssetId,
    menuLoading,
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
    // context folders
    addContextFolderDialogOpen,
    setAddContextFolderDialogOpen,
    handleAddContextPaths,
    handleBrowseContextDir,
  } as const;
}

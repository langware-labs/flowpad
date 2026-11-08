import { t } from '@lingui/core/macro';
import { sectionRecordTypes } from './section-record-types';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Home, Link, Trash2 } from 'lucide-react';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetEditor, AssetMode, AssetRoutingMethod } from '@src/navigation/asset-doc-types';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import apiClient from '@sdk/client';
import { dataContext, DiagnosisRequest, fsManager, fsStore, Project, RecordType, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { ViewType } from '@src/types/ViewType';
import { notify } from '@src/notifications';
import { getDescriptor } from '@src/components/quick-create';
import { useAssetStats } from '@src/hooks/use-asset-stats';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useAssetTreeRefresh } from '@src/hooks/useAssetTreeRefresh';
import { useAddDependency } from '@src/hooks/use-add-dependency';
import { useProjectAssetMenu } from '@src/hooks/use-project-asset-menu';
import { useProjectDependencies } from '@src/hooks/use-project-dependencies';
import { useSystemTools } from '@src/hooks/use-system-tools';
import {
  assetScopeBucket,
  defaultScopeFilter,
  pinnedProjectId,
  projectScope,
  scopeIncludesUser,
  unionAssetBucket,
} from '@src/lib/scope-filter';
import { isProjectHomeSurface } from './asset-body-content';
import type { AssetScopeBucket, ScopeFilter } from '@src/lib/scope-filter';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import { assetTypeRoot } from '@src/components/browseable-tree/adapters/assetTypeRoot';
import { chartsRoot } from '@src/components/browseable-tree/adapters/chartsRoot';
import { useMyEndpoints } from '@src/components/llm-endpoints/my-endpoints';
import { requestsInScope, useMyDiagnosisRequests } from '@src/components/browseable-tree/adapters/diagnosisRequestRoot';
import {
  ASSET_CONTEXT_FOLDERS_ROOT_ID,
  assetContextFolderNodeId,
  assetContextFoldersRoot,
} from '@src/components/browseable-tree/adapters/assetContextFoldersRoot';
import { useDataSourcesRoots } from '@src/components/browseable-tree/adapters/dataSourcesRoot';
import { flatEntityRoots } from '@src/components/browseable-tree/adapters/flatEntityRoot';
import {
  basename as fsBasename,
  fsDragEntries,
  fsFileViewerPointerForVfs,
  fsFolderNodeId,
  fsFolderRoot,
  normalizeRel,
  type FsDragItem,
} from '@src/components/browseable-tree/adapters/fsFolderRoot';
import { useExplorerComputeNode } from '@src/components/explorer-view/useExplorerComputeNode';
import {
  markdownFolderRoot,
} from '@src/components/browseable-tree/adapters/markdownFolderRoot';
import type { Browseable, BrowseableRoot, DroppedFileEntry } from '@src/components/browseable-tree/types';
import type { MultiSelectAction } from '@src/components/navigator-panel/types';
import type { FsOpsHost } from '@src/components/browseable-tree/adapters/fsFileOps';
import { useMenuDialogs } from '@src/components/ui/browseable-menu';
import { dockPointerForFile } from '@src/navigation/local-file-pointer';
import type { AssetFilter } from './assetFilter';
import { DEFAULT_ASSET_FILTER } from './assetFilter';

const HIDDEN_TYPES = new Set<string>([RecordType.ANNOTATION, RecordType.PROJECT, RecordType.COMPUTE_OP]);

// --- path helpers (mirrors AssetsPage; pure) -------------------------------
function normalizeTreePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}
function joinRelPath(parent: string, name: string): string {
  const base = normalizeTreePath(parent);
  const cleanName = name.replace(/^\/+/, '').replace(/\/+$/, '');
  return base ? `${base}/${cleanName}` : cleanName;
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
  const {
    types: allTypes,
    isLoading: typesLoading,
    error: typesError,
    reload: reloadTypes,
  } = useAssetTypes({ allUserTypes: true });
  const { indexType } = useSystemTools();
  const [newTypeTarget, setNewTypeTarget] = useState<string | null>(null);
  const [newTypeDialogOpen, setNewTypeDialogOpen] = useState(false);

  const currentProjectId = dataContext.project?.id ?? null;
  const currentProjectName = dataContext.project?.getDisplayName() ?? dataContext.project?.name ?? null;

  const isProjectView = currentDock?.viewType === ViewType.PROJECT;
  const { projectId: urlProjectId, assetSubPointer } = isProjectView
    ? DockPointer.splitProjectPointer(currentDock?.pointer)
    : { projectId: null, assetSubPointer: currentDock?.pointer ?? '' };
  const projectSeedScope = useMemo(() => (urlProjectId ? defaultScopeFilter(urlProjectId) : null), [urlProjectId]);
  const effectivePointer = isProjectView ? assetSubPointer : (currentDock?.pointer ?? '');

  const urlScope = useMemo<ScopeFilter>(
    () => currentDock?.scopeFilter ?? projectSeedScope ?? defaultScopeFilter(currentProjectId),
    [currentDock, projectSeedScope, currentProjectId],
  );
  const scopeProjectId = urlProjectId ?? pinnedProjectId(urlScope) ?? currentProjectId;
  const scopeProjectName = scopeProjectId === currentProjectId ? currentProjectName : null;
  const { dataSourcesRoot, channelsRoot } = useDataSourcesRoots(scopeProjectId ?? null);

  // The scoped project entity, watched so `include_dirs` edits (add/remove
  // dependency) re-render the tree. Backs the "Dependencies" root.
  const scopeProjectTypeId = useMemo(
    () => (scopeProjectId ? new TypeId(Project.type, scopeProjectId) : null),
    [scopeProjectId],
  );
  const { data: scopeProject, refetch: refetchScopeProject } = useEntity<Project>(scopeProjectTypeId, {
    watch: true,
    enabled: !!scopeProjectTypeId,
  });
  const hasScopeProject = !!scopeProject;
  const {
    contextDirInfos,
    dependencies,
    remove: removeDependency,
    install: installDependency,
  } = useProjectDependencies(scopeProject);

  // The compute node whose VFS backs the "Files" root and the fs-drop copy —
  // the same resolution the body's fs/ file manager (ContextFolderBrowser) uses,
  // so tree and table browse one VFS.
  const { typeId: fsTypeId, locatorTypeId: fsLocatorTypeId } = useExplorerComputeNode();
  // The SCOPED project's mount (not the ambient active project's) — the Files
  // root anchors at the project the tree is showing.
  const filesAnchor = useMemo(() => {
    if (!scopeProject) return '';
    return normalizeRel(scopeProject.fs_storage_mount_path || scopeProject.name || '');
  }, [scopeProject]);

  const [assetFilter] = useState<AssetFilter>(() => ({ ...DEFAULT_ASSET_FILTER }));

  const openAssetTypeId = useMemo<TypeId | null>(() => {
    if (!effectivePointer.startsWith('editor/')) return null;
    try {
      const p = AssetDocPointer.parse(effectivePointer);
      // `llm_endpoint` joins `code` in the exclusion: it is entity-backed but has no local
      // row (a projection of hub state), so resolving it would fire a GET that always 404s.
      if (
        p.editor !== AssetEditor.CODE &&
        p.editor !== AssetEditor.LLM_ENDPOINT &&
        p.method === AssetRoutingMethod.TYPEID
      ) {
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
  const openAssetFields = openAsset as { asset_ref?: string; scope?: string | null; project_id?: string | null } | null;
  const openAssetBucket = useMemo<AssetScopeBucket>(() => assetScopeBucket(openAssetFields), [openAssetFields]);
  const [suppressedAssetId, setSuppressedAssetId] = useState<string | null>(null);

  const effectiveFilter = useMemo<AssetFilter>(() => {
    const useBucket = openAssetBucket && openAssetId !== suppressedAssetId;
    const scope = useBucket ? unionAssetBucket(urlScope, openAssetBucket) : urlScope;
    return { ...assetFilter, scope };
  }, [assetFilter, urlScope, openAssetBucket, openAssetId, suppressedAssetId]);

  const {
    stats: assetStats,
    isLoading: statsLoading,
    error: statsError,
    reload: reloadStats,
  } = useAssetStats(effectiveFilter.scope);

  // The scoped project's server-computed menu: per-folder counts for the project and,
  // nested under it, every dependency (recursively). Backs the Packages rows only —
  // each folder's badge counts what that folder's row lists.
  const { nodesByPath: menuNodesByPath, refresh: reloadAssetMenu } = useProjectAssetMenu(scopeProject);
  // The dependency folders that hold documents — the menu nodes below the project's own
  // mount with markdown of their own. Under the Dependencies scope the Documents tree
  // lists exactly these folders' vaults: one with no documents would only read "Empty".
  // Keyed on CONTENT, so a menu refetch with the same folders keeps the Set's identity
  // (and the tree roots built from it) stable.
  const scopeMount = scopeProject?.fs_storage_mount_path ?? '';
  const dependencyRootsKey = Array.from(menuNodesByPath.entries())
    .filter(
      ([path, node]) =>
        path && path !== scopeMount && (node.groups ?? []).some((g) => g.type_name === 'markdown' && g.own_count > 0),
    )
    .map(([path]) => path)
    .join('|');
  const dependencyRoots = useMemo(
    () => new Set(dependencyRootsKey ? dependencyRootsKey.split('|') : []),
    [dependencyRootsKey],
  );

  // The budgets this person may spend — read once here for the count badge; the tree
  // adapter and the body read the same cached answer.
  const { endpoints: myEndpoints } = useMyEndpoints();
  const myDiagnosisRequests = useMyDiagnosisRequests();

  // Tags are row-only (never indexed), so `asset-stats` has no `tag` count and the Tag root
  // stayed hidden even in dev mode. Their count is how many Tag entities the box lists.
  const [tagCount, setTagCount] = useState(0);
  useEffect(() => {
    let live = true;
    void Promise.resolve(apiClient.get('/graph/tag'))
      .then((rows) => live && setTagCount(Array.isArray(rows) ? rows.length : 0))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [assetStats.per_type]);

  // ONE count source, the same scope as the list: asset-stats counts exactly the rows
  // `/search?top_level=true` returns for `effectiveFilter.scope` (nested rows are
  // subtracted server-side). Dependency assets are counted only when the scope asks for
  // them (the Dependencies mode); the per-folder menu counts belong to the Packages rows,
  // never to a type row whose list cannot show them.
  const typeCounts = useMemo(() => {
    const counts = new Map(Object.entries(assetStats.per_type));
    // A section counts what it lists: Documents = markdown + its .docx / .txt files.
    for (const [type, n] of Array.from(counts)) {
      const extra = sectionRecordTypes(type).slice(1).reduce((sum, other) => sum + (counts.get(other) ?? 0), 0);
      if (extra) counts.set(type, n + extra);
    }
    // LLM endpoints are neither indexed nor path-attributed, so neither source above can
    // see them and the row would be hidden for everyone outside dev mode. Their count is
    // simply how many the box lists.
    counts.set(RecordType.LLM_ENDPOINT, myEndpoints.length);
    // Diagnosis requests likewise have no file to index or attribute: the hub lists them, and
    // the scope narrows them to the project each was opened under (or the user, for the rest).
    counts.set(DiagnosisRequest.type, requestsInScope(myDiagnosisRequests, effectiveFilter.scope).length);
    counts.set('tag', tagCount);
    return counts;
  }, [assetStats.per_type, myEndpoints.length, myDiagnosisRequests, effectiveFilter.scope, tagCount]);

  // An LLM endpoint belongs to a PERSON, never to a project — it is exactly the kind of
  // user-scoped asset the User chip exists for. Under a project-only scope the row would
  // claim the project owns budgets it has nothing to do with, so it is dropped there
  // rather than listed with the same contents under every project.
  const visibleTypes = useMemo(
    () =>
      allTypes.filter(
        (t) =>
          !HIDDEN_TYPES.has(t.type_name) &&
          (t.type_name !== (RecordType.LLM_ENDPOINT as string) || scopeIncludesUser(effectiveFilter.scope)),
      ),
    [allTypes, effectiveFilter.scope],
  );

  // Gate every browsing mode on live counts. Key on the shown set so count
  // updates within a category do not rebuild its roots.
  const shownTypesKey = useMemo(() => {
    if (statsLoading) return '';
    return visibleTypes
      .filter((t) => (typeCounts.get(t.type_name) ?? 0) > 0)
      .map((t) => t.type_name)
      .join(',');
  }, [statsLoading, visibleTypes, typeCounts]);

  // The types the menu actually lists. Derived purely from `shownTypesKey` +
  // `visibleTypes`, so its array identity is stable while the shown set is.
  const displayTypes = useMemo(() => {
    if (shownTypesKey === '') return []; // loading, or genuinely nothing to show
    const shown = new Set(shownTypesKey.split(','));
    return visibleTypes.filter((t) => shown.has(t.type_name));
  }, [shownTypesKey, visibleTypes]);

  // First-load spinner for the type list: true only until the first counts land
  // (react-query `isLoading` is first-load-only, so scope refetches with a warm
  // cache don't re-flash it).
  const menuLoading = typesLoading || statsLoading;
  const menuError = typesError ?? statsError;
  // Reload everything the tree reads — types, counts, the dependency menu — then
  // re-list every root in place, so counts and rows refresh together.
  const reloadMenu = () => {
    void Promise.all([reloadTypes(), reloadStats(), reloadAssetMenu()])
      .then(() => {
        for (const t of visibleTypes) refreshNode(`asset-type:${t.type_name}`);
        refreshNode(ASSET_CONTEXT_FOLDERS_ROOT_ID);
      })
      .catch(() => {});
  };

  // Reactivity only: keep each type's tree root live. A created / indexed /
  // scanned entity arrives as a `data_op`; this re-fetches the affected root
  // (and primes empty-at-mount roots) so the list never goes stale until a
  // manual refresh. See useAssetTreeRefresh.
  const visibleTypeNames = useMemo(() => visibleTypes.map((t) => t.type_name), [visibleTypes]);
  // Same mode-filtered set the type roots are built from — handed to the
  // dependencies adapter so its nested per-type rows honor the same gate.
  const visibleTypeNameSet = useMemo(() => new Set(visibleTypeNames), [visibleTypeNames]);
  useAssetTreeRefresh(visibleTypeNames, effectiveFilter.scope);
  // The Documents root lists vaults; when the list changes (it often arrives after
  // the first render) re-list the root in place — its id is stable.
  const markdownVaultsKey = (visibleTypes.find((t) => t.type_name === 'markdown')?.vaults ?? [])
    .map((v) => v.absPath)
    .join('|');
  // The dependency closure arrives with the (async) asset menu; under the
  // Dependencies scope it decides which vaults the root lists.
  useEffect(() => {
    refreshNode('asset-type:markdown');
  }, [markdownVaultsKey, dependencyRootsKey]);
  const creatableTypes = useMemo(
    () => new Set(allTypes.filter((t) => t.creatable).map((t) => t.type_name)),
    [allTypes],
  );

  const openScoped = useCallback(
    (scope: ScopeFilter) => {
      const base =
        effectivePointer === (AssetMode.PROJECT_HOME as string) && !pinnedProjectId(scope)
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
      navigation.openDock(p.viewType === ViewType.ASSETS ? p.withScopeFilter(p.scopeFilter ?? urlScope) : p);
    },
    [navigation, urlScope],
  );

  // ── Dependencies (project flow.json) ──────────────────────────────────────
  // Mutations live in the shared useProjectDependencies hook (destructured
  // above); the watched entity re-renders the root's rows. Adding is the shared
  // useAddDependency flow — the root's "+" opens its source dialog, and the
  // create-new surface's tiles run the same sources.
  const ctxFolder = useAddDependency({ project: scopeProject, onAdded: refetchScopeProject });

  const handleRemoveDependency = useCallback(
    async (name: string, dir: string | null) => {
      try {
        await removeDependency(name);
      } catch (err) {
        notify.error({
          title: t`Failed to remove package`,
          message: err instanceof Error ? err.message : undefined,
        });
        return;
      }
      // Drop the root's cached children: the tree caches `listChildren` per node
      // id, so rebuilding `roots` from the updated entity is not enough — an
      // expanded root keeps rendering the rows it already fetched, leaving the
      // removed folder on screen next to counts that already dropped.
      refreshNode(ASSET_CONTEXT_FOLDERS_ROOT_ID);
      if (!dir) return;
      // If the body is showing the removed folder (or a subfolder of it), fall
      // back to the plain asset list so the view isn't stranded.
      const rel = normalizeRel(DockPointer.parseAssetFsPointer(effectivePointer)?.entitySubPath ?? '');
      const removed = normalizeRel(dir);
      if (rel && removed && (rel === removed || rel.startsWith(`${removed}/`))) {
        navigateAsset(DockPointer.forAssetList('all'));
      }
    },
    [removeDependency, effectivePointer, navigateAsset],
  );

  const handleInstallDependency = useCallback(
    async (name: string) => {
      try {
        await installDependency(name);
      } catch (err) {
        notify.error({
          title: t`Failed to install package`,
          message: err instanceof Error ? err.message : undefined,
        });
        return;
      }
      refreshNode(ASSET_CONTEXT_FOLDERS_ROOT_ID);
    },
    [installDependency],
  );

  // Tree node id of a drop destination: the dependency row itself when
  // `dir` IS a dependency dir, else the expanded subfolder's fs node — so the
  // refresh hits the node the user actually dropped on.
  const contextTreeNodeId = useCallback(
    (dir: string) => {
      const rel = normalizeRel(dir);
      const isTop = contextDirInfos.some((info) => normalizeRel(info.path) === rel);
      return isTop || !fsTypeId ? assetContextFolderNodeId(dir) : fsFolderNodeId(fsTypeId, rel);
    },
    [contextDirInfos, fsTypeId],
  );

  // Drop from a Files row (tree or body table) onto a dependency row or
  // any folder inside it → copy the file(s)/folder(s) into that exact folder.
  // Copy, not move — pulling something into the context shouldn't relocate it
  // in the project. A multi-selection drag carries every selected entry
  // (fsDragEntries).
  const handleDropIntoContextDir = useCallback(
    async (item: FsDragItem, dir: string) => {
      if (!fsTypeId) return;
      const destRel = normalizeRel(dir);
      const entries = fsDragEntries(item);
      let copied = 0;
      const failed: string[] = [];
      for (const entry of entries) {
        const name = fsBasename(entry.relPath) || entry.label;
        // Per-entry try: one bad entry must not abort the rest of a
        // multi-selection drop.
        try {
          const destAbs = `/${joinRelPath(destRel, name)}`;
          const sourceAbs = `/${normalizeRel(entry.relPath)}`;
          if (await fsManager.exists(fsTypeId, destAbs)) {
            failed.push(`"${name}" already exists`);
            continue;
          }
          await fsManager.copy(fsTypeId, sourceAbs, destAbs);
          copied++;
        } catch (err) {
          console.error(`[AssetsNavigator] Failed to copy "${name}" into dependency folder:`, err);
          failed.push(`"${name}" failed`);
        }
      }
      if (copied) {
        fsStore.getState().invalidate(fsTypeId, `/${destRel}`, 'browse');
        refreshNode(contextTreeNodeId(dir));
        notify.success({
          title:
            copied > 1
              ? `Copied ${copied} items to ${fsBasename(dir) || dir}`
              : `Copied "${fsBasename(entries[0].relPath) || entries[0].label}" to ${fsBasename(dir) || dir}`,
        });
      }
      if (failed.length) {
        notify.error({ title: t`Not copied into package folder`, message: failed.join(', ') });
      }
    },
    [fsTypeId, contextTreeNodeId],
  );

  // OS files/folders dropped onto a dependency row → upload into that
  // folder, preserving the dropped structure (each entry's relPath includes
  // any nested directories; the fs upload creates intermediate dirs).
  const handleExternalDropIntoContextDir = useCallback(
    async (entries: DroppedFileEntry[], dir: string) => {
      if (!fsTypeId) return;
      const base = normalizeRel(dir);
      try {
        // Group by destination subdir so each fs upload lands a whole batch.
        const byDest = new Map<string, File[]>();
        for (const { file, relPath } of entries) {
          const idx = relPath.lastIndexOf('/');
          const subdir = idx >= 0 ? relPath.slice(0, idx) : '';
          const dest = `/${subdir ? joinRelPath(base, subdir) : base}`;
          byDest.set(dest, [...(byDest.get(dest) ?? []), file]);
        }
        for (const [dest, files] of byDest) {
          await fsStore.getState().uploadFiles(fsTypeId, dest, files);
        }
        fsStore.getState().invalidate(fsTypeId, `/${base}`, 'browse');
        refreshNode(contextTreeNodeId(dir));
        notify.success({
          title:
            entries.length > 1
              ? `Added ${entries.length} files to ${fsBasename(dir) || dir}`
              : `Added "${entries[0]?.relPath}" to ${fsBasename(dir) || dir}`,
        });
      } catch (err) {
        console.error('[AssetsNavigator] Failed to add dropped files to dependency folder:', err);
        notify.error({ title: t`Failed to add files to package folder` });
      }
    },
    [fsTypeId, contextTreeNodeId],
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
            name: deletable.length > 1 ? `${deletable.length} items` : (deletable[0]?.label ?? 'item'),
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
        label: t`Copy links`,
        // Entity rows only — folder files have no shareable deep link.
        enabledWhen: (items) => items.length > 0 && items.every((n) => n.selectionType !== 'file'),
        run: async (items, ctx) => {
          const urls = items
            .map((n) => (n.pointer ? navigation.getDockUrl(n.pointer) : null))
            .filter((u): u is string => !!u);
          if (urls.length === 0) return;
          try {
            await navigator.clipboard.writeText(urls.join('\n'));
            notify.success({ title: t`Copied ${urls.length} link${urls.length > 1 ? 's' : ''}` });
          } catch {
            notify.error({ title: t`Failed to copy links` });
          }
          ctx.clearSelection();
        },
      };

      return [copyLinksAction, deleteAction];
    },
    [navigation],
  );

  // URL-first: the navigation cursor is always the real dock. A canonical
  // TypeId editor URL cannot itself contain the entity's VFS path, so expose a
  // separate, read-only resource cursor after the URL-addressed entity resolves.
  // The tree uses that cursor only to reveal the corresponding filesystem row;
  // clicks and route identity continue to use `treeActivePointer`.
  //
  // Through the SAME predicate the body uses: a bare sub-pointer under a project
  // scope renders the project home, and the tree compares node pointers
  // literally — so without naming that row here, the row whose content fills the
  // body reads as unselected. Re-deriving the rule locally is how the two drift.
  const treeActivePointer = useMemo(() => {
    if (!currentDock || currentDock.viewType !== ViewType.ASSETS || currentDock.pointer) return currentDock ?? null;
    const homeProjectId = pinnedProjectId(urlScope);
    if (!homeProjectId) return currentDock;
    return isProjectHomeSurface({ isProjectView: false, pointer: currentDock.pointer, scopedProjectId: homeProjectId })
      ? DockPointer.forAssetProjectHome({ scope: projectScope(homeProjectId) })
      : currentDock;
  }, [currentDock, urlScope]);
  const treeActiveResourcePointer = useMemo(() => {
    if (!openAssetTypeId || !openAssetFields?.asset_ref) return null;
    return DockPointer.forAssetEditor(openAssetTypeId.type, openAssetFields.asset_ref);
  }, [openAssetTypeId, openAssetFields?.asset_ref]);

  // File-manager actions on the Files and Documents trees: their name prompts
  // and confirms render once, from the navigator (`fileOpsDialogs`).
  const fileDialogs = useMenuDialogs();
  const { requestName, confirm } = fileDialogs;
  // Read through a ref: rows keep the host they were built with, so the host
  // must stay one object while the open dock changes underneath it.
  const openDockRef = useRef(currentDock);
  openDockRef.current = currentDock;
  const fileOpsHost = useMemo<FsOpsHost>(
    () => ({
      requestName,
      confirm,
      navigate: navigateAsset,
      // A renamed / moved file that is open follows to its new path, so the
      // editor doesn't sit on a path that no longer exists.
      onPathMoved: (from, to) => {
        const open = openDockRef.current?.resourceVfsPath?.machinePath;
        if (!open) return;
        if (open === from) navigateAsset(dockPointerForFile(to));
        else if (open.startsWith(`${from}/`)) navigateAsset(dockPointerForFile(`${to}${open.slice(from.length)}`));
      },
    }),
    [requestName, confirm, navigateAsset],
  );

  const handleNew = useCallback((type: string) => {
    setNewTypeTarget(type);
    setNewTypeDialogOpen(true);
  }, []);

  const handleNewConfirm = useCallback(
    async (name: string) => {
      if (!name.trim() || !newTypeTarget) return;
      const descriptor = getDescriptor(newTypeTarget);
      if (!descriptor) {
        notify.error({ title: i18n._(msg`Cannot create ${newTypeTarget}`) });
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
        notify.success({ title: i18n._(res.toastTitle) });
        // Local create: poke this type's tree root so the new entity shows
        // immediately. The useAssetTreeRefresh subscription also covers it
        // (and remote/async creates), but the explicit poke avoids waiting on
        // the data_op echo — mirroring the delete path.
        refreshNode(`asset-type:${newTypeTarget}`);
        if (res.pointer) {
          navigateAsset(res.pointer);
          setNewTypeTarget(null);
          return;
        }
      } catch (err) {
        console.error('[AssetsNavigator] Failed to create:', err);
        notify.error({ title: t`Failed to create` });
      }
      setNewTypeTarget(null);
    },
    [newTypeTarget, navigateAsset, effectiveFilter.scope],
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
            label: i18n._(msg`Project home`),
            tag: 'ProjectHome',
            icon: <Home className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
            pointer: isProjectView
              ? DockPointer.forProject(scopeProjectId)
              : DockPointer.forAssetProjectHome({ scope: projectScope(scopeProjectId) }),
          },
        ]),
      );
    }
    const typeRoots = displayTypes.map((t) => {
      if (t.type_name === 'markdown') {
        return markdownFolderRoot(t, {
          indexType,
          onNew: handleNew,
          fileOps: fileOpsHost,
          filter: effectiveFilter,
          dependencyRoots,
          onOpenKnowledgeBrowser: (absPath) => navigation.openDock(DockPointer.forKnowledgeBrowser(absPath, 'vfs')),
        });
      }
      const typeDeps = { indexType, onNew: handleNew, creatableTypes, filter: effectiveFilter };
      // A project's charts read as a tree: their folders, the assets that declare them, sub-flows.
      if (t.type_name === 'chart' && scopeProject) {
        return chartsRoot(t, {
          ...typeDeps,
          projectRoot: scopeProject.fs_storage_mount_path ?? '',
          loadDeclarers: async () => (await scopeProject.dependencies({ declarers: true })).declarers ?? [],
        });
      }
      return assetTypeRoot(t, typeDeps);
    });
    // Files — the scoped project's real on-disk tree, right below the Task
    // section. Rows address the Assets body's fs/ file manager (the same body
    // the dependency rows use), and are draggable onto dependency rows.
    if (hasScopeProject && fsTypeId && fsLocatorTypeId && filesAnchor) {
      const filesRoot = fsFolderRoot({
        typeId: fsTypeId,
        anchorRelPath: filesAnchor,
        scope: effectiveFilter.scope,
        label: i18n._(msg`Files`),
        rootIcon: <FolderOpen className="h-4 w-4 flex-shrink-0 text-muted-foreground" />,
        locatorTypeId: fsLocatorTypeId,
        pointerForVfs: (path) => DockPointer.forAssetFs(path),
        filePointerForVfs: fsFileViewerPointerForVfs,
        draggable: true,
        fileOps: fileOpsHost,
      });
      const taskIdx = displayTypes.findIndex((t) => t.type_name === (RecordType.TASK as string));
      typeRoots.splice(taskIdx >= 0 ? taskIdx + 1 : typeRoots.length, 0, filesRoot);
    }
    list.push(...typeRoots);
    if (dataSourcesRoot) list.push(dataSourcesRoot);
    if (channelsRoot) list.push(channelsRoot);
    // Dependencies (project flow.json) — shown whenever a project is in scope
    // (even with none yet, so the "+" add action is reachable).
    if (hasScopeProject) {
      list.push(
        assetContextFoldersRoot({
          dirs: contextDirInfos,
          dependencies,
          fsTypeId,
          fsLocatorTypeId,
          onAdd: ctxFolder.openSource,
          onRemove: handleRemoveDependency,
          onInstall: handleInstallDependency,
          onDropItem: handleDropIntoContextDir,
          onExternalDrop: handleExternalDropIntoContextDir,
          projectId: scopeProjectId,
          menuByPath: menuNodesByPath,
          visibleTypes: visibleTypeNameSet,
        }),
      );
    }
    return list;
  }, [
    dataSourcesRoot,
    channelsRoot,
    displayTypes,
    indexType,
    handleNew,
    fileOpsHost,
    creatableTypes,
    effectiveFilter,
    navigation,
    isProjectView,
    scopeProjectId,
    hasScopeProject,
    scopeProject,
    fsTypeId,
    fsLocatorTypeId,
    filesAnchor,
    contextDirInfos,
    dependencies,
    ctxFolder.openSource,
    handleRemoveDependency,
    handleInstallDependency,
    handleDropIntoContextDir,
    handleExternalDropIntoContextDir,
    menuNodesByPath,
    dependencyRoots,
    visibleTypeNameSet,
  ]);
  return {
    roots,
    treeActivePointer,
    treeActiveResourcePointer,
    openAssetId,
    menuLoading,
    menuError,
    reloadMenu,
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
    // dependencies — the add flow's dialogs, rendered by the view
    dependencyDialogs: ctxFolder.dialogs,
    fileOpsDialogs: fileDialogs.dialogs,
  } as const;
}

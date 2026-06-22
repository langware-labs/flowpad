import { AssetEditorRouter, hasEditor } from '@src/components/assets/editor/AssetEditorRouter';
import { WikiResolveView } from '@src/components/assets/editor/WikiResolveView';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetEditor, AssetMode, AssetRoutingMethod, DEFAULT_WIKI_SPACE } from '@src/navigation/asset-doc-types';
import { InputDialog } from '@src/components/ui/input-dialog';
import { Button } from '@src/components/ui/button';
import { getDescriptor } from '@src/components/quick-create';
import { RecordSearchBar } from '@src/components/record-search-bar/RecordSearchBar';
import { InlineSearchResults } from '@src/pages/home-landing/InlineSearchResults';
import type { SearchFilters, SearchResult as RecordSearchResult } from '@src/hooks/use-record-search';
import { notify } from '@src/notifications';
import { DockPointer } from '@src/navigation/DockPointer';
import { navigateToResult } from '@src/navigation/record-type-nav';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dataContext, fsManager, fsStore, RecordType, systemTools, TypeId, VFSPath } from '@sdk';
import apiClient from '@sdk/client';
import { AlertCircle, BookOpen, ChevronRight, PackageSearch, PanelLeft, PanelLeftClose, X } from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@src/components/ui/breadcrumb';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AssetFilter } from './assetFilter';
import { DEFAULT_ASSET_FILTER } from './assetFilter';
import { applyScopeToParams, assetScopeBucket, defaultScopeFilter, unionAssetBucket } from '@src/lib/scope-filter';
import type { AssetScopeBucket, ScopeFilter } from '@src/lib/scope-filter';
import { useEntity } from '@sdk/react/hooks';
import { useSearchScopeToggle } from '@src/hooks/use-global-search-scope';
import { useIndexStatus } from '@src/hooks/use-index-status';
import { useAssetStats } from '@src/hooks/use-asset-stats';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { ScopeFilterIconBar } from '@src/components/scope-filter/ScopeFilterIconBar';
import { ViewType } from '@src/types/ViewType';
import { AssetListView } from './AssetListView';
import { MarkdownIndexPanel } from './MarkdownIndexPanel';
import { BrowseableTree } from '@src/components/browseable-tree';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import { assetTypeRoot, AssetTypeCountsContext } from '@src/components/browseable-tree/adapters/assetTypeRoot';
import {
  markdownFolderNodeId,
  markdownFolderRoot,
  type MarkdownDragItem,
  type MarkdownFolderTarget,
} from '@src/components/browseable-tree/adapters/markdownFolderRoot';
import { useAssetTypes, type AssetTypeVault } from '@src/hooks/use-asset-types';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { INDEX_BUILD_LABEL, INDEX_PROMPT_DESCRIPTION, INDEX_PROMPT_TITLE } from '@src/components/search-index/index-copy';
import type { SearchResult } from '@src/hooks/use-asset-search';
// Side-effect column registrations
import '@src/components/assets/columns/assetColumns';
import '@src/components/assets/columns/bookmarkColumns';
import '@src/components/assets/columns/skillColumns';
import '@src/components/assets/columns/agentColumns';
import '@src/components/assets/columns/workflowColumns';
import '@src/components/assets/columns/taskColumns';
import '@src/components/assets/columns/projectColumns';
import '@src/components/assets/columns/planColumns';
import '@src/components/assets/columns/claudeMemoryColumns';
import '@src/components/assets/columns/claudeMdColumns';
import '@src/components/assets/columns/claudeRulesColumns';
// Side-effect filter registrations
import '@src/components/assets/filters/taskFilters';

interface ParsedAssetPointer {
  mode: 'editor' | 'list' | 'folder' | 'wiki' | null;
  typeName: string | null;
  /** Only set when mode === 'folder'. */
  folderTypeid: string | null;
  /** Only set when mode === 'folder'. VFS relPath under the typeid. */
  folderRelPath: string | null;
  /** Only set when mode === 'wiki'. Decoded link target name. */
  wikiName: string | null;
  /** Only set when mode === 'wiki'. The space the name resolves within (default @local). */
  wikiSpace: string | null;
}

function parseAssetPointer(pointer: string | undefined): ParsedAssetPointer {
  const empty: ParsedAssetPointer = {
    mode: null, typeName: null, folderTypeid: null, folderRelPath: null, wikiName: null, wikiSpace: null,
  };
  if (!pointer) return empty;
  if (pointer.startsWith('editor/')) {
    return { ...empty, mode: 'editor' };
  }
  if (pointer.startsWith('list/')) {
    return { ...empty, mode: 'list', typeName: pointer.slice('list/'.length) || null };
  }
  if (pointer.startsWith('folder/')) {
    const folder = DockPointer.parseAssetFolderPointer(pointer);
    if (folder) {
      return {
        ...empty,
        mode: 'folder',
        typeName: folder.typeName,
        folderTypeid: folder.typeid,
        folderRelPath: folder.relPath,
      };
    }
  }
  if (pointer.startsWith('wiki/')) {
    // Canonical grammar: wiki/<space>/<name>. Space defaults to @local.
    const rest = pointer.slice('wiki/'.length);
    const slash = rest.indexOf('/');
    const space = slash >= 0 ? rest.slice(0, slash) : DEFAULT_WIKI_SPACE;
    const raw = slash >= 0 ? rest.slice(slash + 1) : rest;
    let name = raw;
    try { name = decodeURIComponent(raw); } catch { /* keep raw */ }
    return { ...empty, mode: 'wiki', typeName: 'markdown', wikiName: name || null, wikiSpace: space || DEFAULT_WIKI_SPACE };
  }
  return empty;
}

/** Given a parsed folder pointer and a list of vaults, return the absolute
 *  filesystem path of the folder (for the parent_path API filter). */
function resolveFolderAbsPath(
  typeid: string,
  relPath: string,
  vaults: AssetTypeVault[],
): string | null {
  for (const v of vaults) {
    if (v.typeid !== typeid) continue;
    if (relPath === v.relPath) return v.absPath;
    if (v.relPath === '' && relPath !== '') {
      return `${v.absPath}/${relPath}`;
    }
    if (relPath.startsWith(v.relPath + '/')) {
      return `${v.absPath}${relPath.slice(v.relPath.length)}`;
    }
  }
  return null;
}

function buildFolderBreadcrumbs(
  typeid: string,
  relPath: string,
  vaults: AssetTypeVault[],
): { label: string; pointer: DockPointer }[] {
  const vault = vaults.find((v) => v.typeid === typeid && (relPath === v.relPath || relPath.startsWith(v.relPath + (v.relPath ? '/' : ''))));
  if (!vault) return [];
  const crumbs: { label: string; pointer: DockPointer }[] = [
    { label: vault.label, pointer: DockPointer.forAssetFolder('markdown', vault.typeid, vault.relPath) },
  ];
  const extra = relPath.slice(vault.relPath.length).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!extra) return crumbs;
  let cursor = vault.relPath;
  for (const seg of extra.split('/')) {
    cursor = cursor ? `${cursor}/${seg}` : seg;
    crumbs.push({
      label: seg,
      pointer: DockPointer.forAssetFolder('markdown', vault.typeid, cursor),
    });
  }
  return crumbs;
}

const HIDDEN_TYPES = new Set<string>([RecordType.ANNOTATION, RecordType.PROJECT]);

const SIDEBAR_COLLAPSED_KEY = 'wiki:sidebar-collapsed';
const SIDEBAR_WIDTH_KEY = 'wiki:sidebar-width';
const SIDEBAR_DEFAULT_WIDTH = 224;
const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 560;

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

/**
 * Extract the editor + absolute path from a vfs-addressed editor pointer, for
 * the rename/move "follow the open file" logic. Returns null for typeid/code/
 * wiki pointers (no file path in the URL to follow).
 */
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

/** Breadcrumb rendered above the folder-filtered AssetListView. Each crumb
 *  except the last navigates to that ancestor; the last is the current page.
 *  A right-aligned X button clears the filter back to the full list. */
function FolderBreadcrumb({
  crumbs,
  onNavigate,
  onClear,
}: {
  crumbs: { label: string; pointer: DockPointer }[];
  onNavigate: (p: DockPointer) => void;
  onClear: () => void;
}) {
  if (crumbs.length === 0) return null;
  return (
    <div
      className="flex items-center gap-1 border-b px-3 py-2 text-xs"
      data-testid="asset-list-breadcrumb"
    >
      <Breadcrumb>
        <BreadcrumbList>
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <React.Fragment key={`${c.pointer.viewType}:${c.pointer.pointer}`}>
                <BreadcrumbItem>
                  {isLast ? (
                    <BreadcrumbPage>{c.label}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      className="cursor-pointer"
                      onClick={() => onNavigate(c.pointer)}
                    >
                      {c.label}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {!isLast && (
                  <BreadcrumbSeparator>
                    <ChevronRight className="h-3 w-3" />
                  </BreadcrumbSeparator>
                )}
              </React.Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      <button
        type="button"
        onClick={onClear}
        title="Clear folder filter"
        aria-label="Clear folder filter"
        data-testid="asset-list-breadcrumb-clear"
        className="ml-auto flex h-5 w-5 items-center justify-center rounded hover:bg-muted"
      >
        <X className="h-3 w-3 text-muted-foreground" />
      </button>
    </div>
  );
}

export function AssetsPage() {
  const { currentDock, navigation } = useDockNavigation();
  const { types: allTypes, isLoading: typesLoading } = useAssetTypes();
  const { indexType, busy, resetAndRescan } = useSystemTools();

  const [refreshKey, setRefreshKey] = useState(0);
  const [newTypeTarget, setNewTypeTarget] = useState<string | null>(null);
  const [newTypeDialogOpen, setNewTypeDialogOpen] = useState(false);
  const [newFolderTarget, setNewFolderTarget] = useState<MarkdownFolderTarget | null>(null);
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const currentProjectId = dataContext.project?.id ?? null;
  const currentProjectName = dataContext.project?.getDisplayName() ?? dataContext.project?.name ?? null;
  // When hosted under `/dock/project/<id>`, the project id comes from the URL.
  // The first segment of the pointer is the projectId; the rest is the same
  // sub-pointer shape AssetsPage already uses under `/dock/assets/<sub>`.
  const isProjectView = currentDock?.viewType === ViewType.PROJECT;
  const { projectId: urlProjectId, assetSubPointer } = isProjectView
    ? DockPointer.splitProjectPointer(currentDock?.pointer)
    : { projectId: null, assetSubPointer: currentDock?.pointer ?? '' };
  // The project the scope filter points at: the URL project on a project page,
  // else the context project. Drives the Project mode + its tooltip name.
  const scopeProjectId = urlProjectId ?? currentProjectId;
  const scopeProjectName = scopeProjectId === currentProjectId ? currentProjectName : null;
  // On a project page, scope is *preselected* to that project (not locked) — the
  // user can still switch to All/User/Selected. `projectSeedScope` is that
  // preselection: it seeds the initial scope, scopes the project index status,
  // and re-applies when navigating between projects.
  const projectSeedScope = useMemo(
    () => (urlProjectId ? defaultScopeFilter(urlProjectId) : null),
    [urlProjectId],
  );
  const effectivePointer = isProjectView ? assetSubPointer : (currentDock?.pointer ?? '');
  // Scope is URL-first: it lives in the dock options (read generically via
  // `DockPointer.scopeFilter`). An explicit option wins; on a project page we
  // default to that project; the bare `/dock/assets` (no option) falls back to
  // the context-aware default (project chip when in a project, else user-only)
  // — NOT a forced "All".
  const urlScope = useMemo<ScopeFilter>(
    () => currentDock?.scopeFilter ?? projectSeedScope ?? defaultScopeFilter(currentProjectId),
    [currentDock, projectSeedScope, currentProjectId],
  );
  // Non-scope filter state (query / tags / per-type filters / folder path).
  // The `scope` field is vestigial here — `effectiveFilter` always derives it
  // from `urlScope`, keeping scope URL-authoritative.
  const [assetFilter, setAssetFilter] = useState<AssetFilter>(() => ({
    ...DEFAULT_ASSET_FILTER,
  }));

  // --- Side menu follows the open asset ---------------------------------
  // The asset open in the editor may live in a different project (or in the
  // user/system scope) than the side-menu's current scope, in which case its
  // type would show 0 count and an empty list. Union the open asset's own
  // scope bucket onto the filter so it stays visible while you view it. The
  // union is derived (recomputed per open, never accumulated); a manual scope
  // change suppresses it for that one asset (see handleScopeChange).
  const openAssetTypeId = useMemo<TypeId | null>(() => {
    if (!effectivePointer.startsWith('editor/')) return null;
    try {
      const p = AssetDocPointer.parse(effectivePointer);
      if (p.editor !== AssetEditor.CODE && p.method === AssetRoutingMethod.TYPEID) {
        return new TypeId(p.value);
      }
    } catch {
      // not an editor/typeid pointer — nothing to union
    }
    return null;
  }, [effectivePointer]);
  const openAssetId = openAssetTypeId?.toString() ?? null;
  const { data: openAsset } = useEntity(openAssetTypeId);
  const openAssetBucket = useMemo<AssetScopeBucket>(
    () => assetScopeBucket(openAsset as { scope?: string | null; project_id?: string | null } | null),
    [openAsset],
  );
  // Manual scope edits suppress the auto-union for the *current* asset only;
  // opening a different asset re-enables it (the guard is keyed to the id).
  const [suppressedAssetId, setSuppressedAssetId] = useState<string | null>(null);

  const effectiveFilter = useMemo<AssetFilter>(() => {
    const useBucket = openAssetBucket && openAssetId !== suppressedAssetId;
    const scope = useBucket ? unionAssetBucket(urlScope, openAssetBucket) : urlScope;
    return { ...assetFilter, scope };
  }, [assetFilter, urlScope, openAssetBucket, openAssetId, suppressedAssetId]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({});
  const [selectedResultIndex, setSelectedResultIndex] = useState(-1);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  });
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const n = raw ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, n));
  });
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  // Project-page index state comes from the project record's own ``.hash``
  // (the project IS a record): never_indexed → CTA, stale → "changes pending".
  // Only meaningful under a locked project scope; global assets keep the plain
  // "refresh search data" rebuild.
  const { state: idxState, refresh: refreshIdxStatus } = useIndexStatus(
    projectSeedScope ?? undefined,
  );
  const projIdx = isProjectView && idxState.phase === 'ready' ? idxState.status : null;
  // Canonical "nothing indexed yet" signal. `idxState` is already scope-aware
  // (project-scoped in project view, unscoped in the assets dock), so this one
  // flag drives both the header CTA and the empty-state prompt.
  const neverIndexed = idxState.phase === 'ready' && idxState.status.never_indexed;
  const changesPending = projIdx?.stale ?? false;
  const lastIndexedAt = projIdx?.last_indexed_at ?? null;

  // Per-type counts for the sidebar badges, sourced from the single scoped
  // `asset-stats` response (counts only) — one request for every type badge,
  // scoped to the active filter so they track the scope/project picker, and
  // reactive: `useAssetStats` invalidates on any asset create/delete data_op.
  const { stats: assetStats } = useAssetStats(effectiveFilter.scope);
  const typeCounts = useMemo(
    () => new Map(Object.entries(assetStats.per_type)),
    [assetStats.per_type],
  );

  useEffect(() => { setSelectedResultIndex(-1); }, [searchQuery]);

  useEffect(() => {
    void systemTools.refreshActivityStatus();
  }, []);

  const handleRebuildIndex = useCallback(async () => {
    // Project view → Fast index scoped to the project (re-stamps the project's
    // own index sentinel). Global view → legacy full reset+rescan.
    if (isProjectView) {
      const params = new URLSearchParams();
      // Always re-index the project itself, regardless of the visible scope.
      applyScopeToParams(params, projectSeedScope ?? effectiveFilter.scope);
      try {
        await apiClient.post(`/graph/compute_node/@local/fs-records/index?${params.toString()}`);
      } finally {
        refreshIdxStatus();
      }
      return;
    }
    void resetAndRescan();
  }, [isProjectView, projectSeedScope, effectiveFilter.scope, refreshIdxStatus, resetAndRescan]);

  const handleSearchSubmit = useCallback(() => {
    const q = searchQuery.trim();
    navigation.openSearch(q ? searchQuery : undefined, searchFilters);
  }, [navigation, searchQuery, searchFilters]);
  const {
    scope: searchScope,
    isLoading: searchScopeLoading,
  } = useSearchScopeToggle(currentProjectId);

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedResultIndex(0); }
    if (e.key === 'Escape') { setSelectedResultIndex(-1); }
  }, []);

  const handleNavigateResult = useCallback((result: RecordSearchResult) => {
    void navigateToResult(result, navigation);
  }, [navigation]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), []);

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    setIsResizingSidebar(true);
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, startWidth + (ev.clientX - startX)),
      );
      setSidebarWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      setIsResizingSidebar(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  // URL-first scope write: scope is a dock option (serialized once, in
  // lib/scope-filter). Writing the URL is the single source of truth —
  // `urlScope` re-derives it on the next render.
  const openScoped = useCallback((scope: ScopeFilter) => {
    const base = currentDock ?? DockPointer.forAssetList('all');
    navigation.openDock(base.withScopeFilter(scope));
  }, [currentDock, navigation]);

  const handleScopeChange = useCallback((scope: ScopeFilter) => {
    openScoped(scope);
    // The user took control of the scope — stop auto-unioning the open asset's
    // bucket for this asset (rule honored only until they open a different one).
    setSuppressedAssetId(openAssetId);
  }, [openScoped, openAssetId]);

  // Asset-shaped pointers (`forAssetEditor`, `forAssetFolder`, `forAssetList`)
  // open at `/dock/assets/<sub>`. Under `/dock/project/<id>` we must rebase
  // them onto the project URL or every tree click, breadcrumb, or row click
  // would jump out of the project shell.
  const navigateAsset = useCallback((p: DockPointer) => {
    // Every in-assets navigation (type click, folder, breadcrumb, row→editor)
    // stays in the SAME scope-keyed tab: re-stamp the current scope onto the
    // freshly-built (scope-less) pointer so the assets tabHash is unchanged and
    // the scope isn't dropped from the URL.
    navigation.openDock(p.withScopeFilter(urlScope));
  }, [navigation, urlScope]);

  // BrowseableTree's adapters key selection off `ViewType.ASSETS` pointers,
  // so in project view we synthesize one from the sub-pointer. Memoized so
  // the tree's `expandParentsForPointer` effect doesn't re-run every render.
  const treeActivePointer = useMemo<DockPointer | null>(() => {
    if (isProjectView) {
      return new DockPointer(ViewType.ASSETS, effectivePointer || undefined);
    }
    return currentDock ?? null;
  }, [isProjectView, effectivePointer, currentDock]);

  const {
    mode,
    typeName: selectedType,
    folderTypeid,
    folderRelPath,
    wikiName,
    wikiSpace,
  } = parseAssetPointer(effectivePointer);
  const isEditorMode = mode === 'editor';
  const isFolderMode = mode === 'folder';
  const isWikiMode = mode === 'wiki';

  const visibleTypes = useMemo(
    () => allTypes.filter((t) => !HIDDEN_TYPES.has(t.type_name)),
    [allTypes],
  );

  const creatableTypes = useMemo(
    () => new Set(allTypes.filter((t) => t.creatable).map((t) => t.type_name)),
    [allTypes],
  );

  const handleScanComplete = useCallback(
    (type: string) => {
      if (type === selectedType) setRefreshKey((k) => k + 1);
    },
    [selectedType],
  );

  const handleNew = useCallback((type: string) => {
    setNewTypeTarget(type);
    setNewTypeDialogOpen(true);
  }, []);

  const handleCreateFolder = useCallback((target: MarkdownFolderTarget) => {
    setNewFolderTarget(target);
    setNewFolderDialogOpen(true);
  }, []);

  const handleNewFolderConfirm = useCallback(async (rawName: string) => {
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
      setRefreshKey((k) => k + 1);
      notify.success({ title: 'Folder created' });
    } catch (err) {
      console.error('[AssetsPage] Failed to create folder:', err);
      notify.error({ title: 'Failed to create folder' });
    } finally {
      setNewFolderTarget(null);
    }
  }, [newFolderTarget]);

  const handleMoveMarkdownItem = useCallback(async (
    item: MarkdownDragItem,
    target: MarkdownFolderTarget,
  ) => {
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

      setRefreshKey((k) => k + 1);

      try {
        await indexType('markdown', effectiveFilter.scope, { force: true });
      } catch (err) {
        console.error('[AssetsPage] Markdown reindex after move failed:', err);
        notify.error({ title: 'Moved, but reindex failed' });
        return;
      }

      notify.success({ title: 'Moved' });
    } catch (err) {
      console.error('[AssetsPage] Failed to move markdown item:', err);
      notify.error({ title: 'Failed to move item' });
    }
  }, [effectiveFilter.scope, effectivePointer, indexType, navigateAsset]);

  const wikiRoots = useMemo(
    () =>
      visibleTypes.map((t) => {
        if (t.type_name === 'markdown') {
          return markdownFolderRoot(t, {
            indexType,
            onNew: handleNew,
            onCreateFolder: handleCreateFolder,
            onMoveItem: handleMoveMarkdownItem,
            onScanComplete: handleScanComplete,
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
          onScanComplete: handleScanComplete,
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
      handleScanComplete,
      navigation,
    ],
  );

  // Resolve the absolute path of the selected folder (from vault metadata),
  // and the effective record_type + filter for the right-panel list view.
  const markdownVaults = useMemo(() => {
    const md = allTypes.find((t) => t.type_name === 'markdown');
    return md?.vaults ?? [];
  }, [allTypes]);

  const folderAbsPath = isFolderMode && folderTypeid && folderRelPath !== null
    ? resolveFolderAbsPath(folderTypeid, folderRelPath, markdownVaults)
    : null;

  const folderCrumbs = isFolderMode && folderTypeid && folderRelPath !== null
    ? buildFolderBreadcrumbs(folderTypeid, folderRelPath, markdownVaults)
    : [];

  const listFilter = useMemo<AssetFilter>(() => {
    if (isFolderMode && folderAbsPath) {
      return { ...effectiveFilter, parentPath: folderAbsPath };
    }
    return effectiveFilter;
  }, [effectiveFilter, isFolderMode, folderAbsPath]);

  const handleNewConfirm = useCallback(async (name: string) => {
    if (!name.trim() || !newTypeTarget) return;
    const descriptor = getDescriptor(newTypeTarget);
    if (!descriptor) {
      notify.error({ title: `Cannot create ${newTypeTarget}` });
      setNewTypeTarget(null);
      return;
    }
    try {
      const res = await descriptor.create({ project: dataContext.project ?? null, name });
      notify.success({ title: res.toastTitle });
      if (res.pointer) {
        navigateAsset(res.pointer);
        setNewTypeTarget(null);
        return;
      }
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error('[AssetsPage] Failed to create:', err);
      notify.error({ title: 'Failed to create' });
    }
    setNewTypeTarget(null);
  }, [newTypeTarget, navigateAsset]);

  const handleRowClick = useCallback((result: SearchResult) => {
    // Projects open in their collaboration space (the "project room"), not
    // the asset editor — the editor router has no page for project entities.
    if (result.record_type === RecordType.PROJECT) {
      navigation.openDock(DockPointer.forProject(result.record_id));
      return;
    }
    const path = result.asset_ref;
    if (!path || !path.startsWith('/')) {
      notify.error({
        title: 'Asset has no file on disk',
        message: `${result.name || result.record_id} is indexed without a valid source path and cannot be opened.`,
      });
      return;
    }
    navigateAsset(DockPointer.forAssetEditor(result.record_type, path));
  }, [navigateAsset, navigation]);

  const handleProjectFilter = useCallback(async (label: string) => {
    try {
      const data = await apiClient.get('/search?record_type=project&limit=200') as { results?: { record_id: string; name: string }[] } | null;
      const projects = data?.results ?? [];
      const match = projects.find((p) => {
        const lastSeg = p.name.replace(/\/$/, '').split('/').filter(Boolean).pop() ?? p.name;
        return lastSeg === label || p.name === label;
      });
      if (match) {
        setAssetFilter({ ...DEFAULT_ASSET_FILTER });
        openScoped({ user: false, projects: [match.record_id] });
      }
    } catch {
      // ignore
    }
  }, [openScoped]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-[52px] flex-shrink-0 items-center gap-1 border-b px-3">
        <button
          type="button"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? 'Show asset tree' : 'Hide asset tree'}
          aria-label={sidebarCollapsed ? 'Show asset tree' : 'Hide asset tree'}
          className="flex h-7 w-7 items-center justify-center rounded hover:bg-muted"
        >
          {sidebarCollapsed ? (
            <PanelLeft className="h-4 w-4 text-muted-foreground" />
          ) : (
            <PanelLeftClose className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        <span className="ml-1 text-sm font-medium">Assets</span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative w-96 shrink-0">
            <RecordSearchBar
              query={searchQuery}
              filters={searchFilters}
              onQueryChange={setSearchQuery}
              onFiltersChange={setSearchFilters}
              onSubmit={handleSearchSubmit}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search..."
            />
            {searchQuery.trim().length >= 2 && (
              <div className="absolute right-0 top-full z-50 w-[600px] pt-1">
                <InlineSearchResults
                  query={searchQuery}
                  filters={searchFilters}
                  scope={searchScope}
                  scopeLoading={searchScopeLoading}
                  selectedIndex={selectedResultIndex}
                  onSelectedIndexChange={setSelectedResultIndex}
                  onOpenFullSearch={handleSearchSubmit}
                  onNavigateResult={handleNavigateResult}
                />
              </div>
            )}
          </div>
          {isProjectView && neverIndexed ? (
            // Never indexed → clear call-to-action (same action, clearer label).
            <Button
              variant="outline"
              size="sm"
              className="h-9 shrink-0 gap-1.5"
              onClick={() => void handleRebuildIndex()}
              disabled={busy}
              data-testid="index-now-cta"
            >
              <PackageSearch className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
              {INDEX_BUILD_LABEL}
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="relative h-9 w-9 shrink-0"
                  onClick={() => void handleRebuildIndex()}
                  disabled={busy}
                  aria-label={isProjectView ? 'Re-index project' : 'Refresh search data'}
                  data-testid="rebuild-index"
                >
                  <PackageSearch className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
                  {isProjectView && changesPending && (
                    <AlertCircle
                      className="absolute -right-0.5 -top-0.5 h-3 w-3 text-amber-500"
                      data-testid="changes-pending-badge"
                    />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {isProjectView
                  ? changesPending
                    ? 'Changes pending next index'
                    : lastIndexedAt
                      ? `Last indexed ${formatTimeAgo(lastIndexedAt)}`
                      : 'Re-index project'
                  : 'Refresh search data'}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Type sidebar — collapsible push drawer, drag-resizable when expanded */}
        <div
          className={`flex-shrink-0 overflow-hidden border-r ${
            isResizingSidebar ? '' : 'transition-[width] duration-200 ease-out'
          }`}
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
          aria-hidden={sidebarCollapsed}
        >
          <div className="flex h-full flex-col" style={{ width: sidebarWidth }}>
            <div className="flex flex-shrink-0 items-center gap-1 border-b p-1.5">
              <ScopeFilterIconBar
                scope={effectiveFilter.scope}
                currentProjectId={scopeProjectId}
                currentProjectName={scopeProjectName}
                onScopeChange={handleScopeChange}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <AssetTypeCountsContext.Provider value={typeCounts}>
                <BrowseableTree
                  roots={wikiRoots}
                  activePointer={treeActivePointer}
                  activeKey={openAssetId}
                  isLoading={typesLoading && wikiRoots.length === 0}
                  onNavigate={navigateAsset}
                />
              </AssetTypeCountsContext.Provider>
            </div>
          </div>
        </div>
        {/* Resize handle for the sidebar — hidden when collapsed */}
        {!sidebarCollapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize asset tree"
            onMouseDown={handleSidebarResizeStart}
            onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
            className={`group relative w-1 flex-shrink-0 cursor-col-resize select-none ${
              isResizingSidebar ? 'bg-primary/40' : 'hover:bg-primary/30'
            }`}
            data-testid="asset-tree-resize-handle"
          />
        )}

        {/* Main content: editor when in editor mode, list view otherwise */}
        <div className="min-w-0 flex-1">
          {isWikiMode && wikiName ? (
            <WikiResolveView name={wikiName} space={wikiSpace ?? DEFAULT_WIKI_SPACE} />
          ) : isEditorMode && effectivePointer ? (
            <AssetEditorRouter pointer={effectivePointer} />
          ) : isFolderMode ? (
            <div className="flex h-full">
              <div className="flex min-w-0 flex-1 flex-col">
                <FolderBreadcrumb
                  crumbs={folderCrumbs}
                  onNavigate={navigateAsset}
                  onClear={() => navigateAsset(DockPointer.forAssetList('markdown'))}
                />
                <div className="min-h-0 flex-1">
                  <AssetListView
                    recordType="markdown"
                    onNew={creatableTypes.has('markdown') ? () => handleNew('markdown') : undefined}
                    refreshKey={refreshKey}
                    onRowClick={hasEditor('markdown') ? handleRowClick : undefined}
                    filter={listFilter}
                    onFilterChange={setAssetFilter}
                    onProjectFilter={handleProjectFilter}
                  />
                </div>
              </div>
              {folderAbsPath && <MarkdownIndexPanel folderAbsPath={folderAbsPath} />}
            </div>
          ) : selectedType ? (
            <AssetListView
              recordType={selectedType}
              onNew={creatableTypes.has(selectedType) ? () => handleNew(selectedType) : undefined}
              refreshKey={refreshKey}
              onRowClick={hasEditor(selectedType) ? handleRowClick : undefined}
              filter={effectiveFilter}
              onFilterChange={setAssetFilter}
              onProjectFilter={handleProjectFilter}
            />
          ) : neverIndexed ? (
            <div className="flex h-full items-center justify-center p-6">
              <div className="flex max-w-sm flex-col items-center gap-3 text-center">
                <PackageSearch className="h-8 w-8 text-muted-foreground" />
                <div className="text-sm font-medium">{INDEX_PROMPT_TITLE}</div>
                <p className="text-sm text-muted-foreground">{INDEX_PROMPT_DESCRIPTION}</p>
                <Button
                  size="sm"
                  className="mt-1 gap-1.5"
                  onClick={() => void handleRebuildIndex()}
                  disabled={busy}
                  data-testid="empty-state-index-cta"
                >
                  <PackageSearch className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
                  {INDEX_BUILD_LABEL}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a type to browse
            </div>
          )}
        </div>
      </div>

      <InputDialog
        open={newTypeDialogOpen}
        onOpenChange={setNewTypeDialogOpen}
        title={`New ${newTypeTarget ?? ''}`}
        description={`Enter a name for the new ${newTypeTarget ?? 'item'}.`}
        placeholder="Name"
        confirmLabel="Create"
        onConfirm={(name) => void handleNewConfirm(name)}
      />
      <InputDialog
        open={newFolderDialogOpen}
        onOpenChange={setNewFolderDialogOpen}
        title="New Folder"
        description={`Create a folder in ${newFolderTarget?.label ?? 'this folder'}.`}
        placeholder="Folder name"
        confirmLabel="Create"
        onConfirm={(name) => void handleNewFolderConfirm(name)}
      />
    </div>
  );
}

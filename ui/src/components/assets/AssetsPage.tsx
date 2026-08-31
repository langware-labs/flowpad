import { t } from '@lingui/core/macro';
import { i18n } from '@lingui/core';
import { AssetEditorRouter, hasEditor } from '@src/components/assets/editor/AssetEditorRouter';
import { WikiResolveView } from '@src/components/assets/editor/WikiResolveView';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import {
  AssetEditor,
  AssetMode,
  AssetRoutingMethod,
  DEFAULT_WIKI_SPACE,
  WIKI_FRAGMENT_PARAM,
} from '@src/navigation/asset-doc-types';
import { ProjectHome } from '@src/components/project-home/ProjectHome';
import { ShareContextFolderButton } from '@src/components/assets/ShareContextFolderButton';
import { useContextFolderForRel } from '@src/hooks/use-context-folder-for-rel';
import { useIsAdvanced } from '@src/components/view-mode';
import { InputDialog } from '@src/components/ui/input-dialog';
import { Button } from '@src/components/ui/button';
import { getDescriptor } from '@src/components/quick-create';
import { notify } from '@src/notifications';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dataContext, RecordType, systemTools, TypeId, VFSPath } from '@sdk';
import type { Project } from '@sdk';
import { showDeleteAssetModal } from '@src/components/assets/delete-asset-modal';
import apiClient from '@sdk/client';
import { BookOpen, ChevronRight, PackageSearch, Trash2, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@src/components/ui/breadcrumb';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AssetFilter } from './assetFilter';
import { DEFAULT_ASSET_FILTER } from './assetFilter';
import {
  applyScopeToParams,
  assetScopeBucket,
  defaultScopeFilter,
  pinnedProjectId,
  projectScope,
  unionAssetBucket,
} from '@src/lib/scope-filter';
import type { AssetScopeBucket, ScopeFilter } from '@src/lib/scope-filter';
import { useEntity } from '@sdk/react/hooks';
import { useIndexStatus } from '@src/hooks/use-index-status';
import { ViewType } from '@src/types/ViewType';
import { AssetListView } from './AssetListView';
import { isProjectHomeSurface, shouldShowIndexPrompt } from './asset-body-content';
import { ContextFolderBrowser } from './ContextFolderBrowser';
import { MarkdownIndexPanel } from './MarkdownIndexPanel';
import { useAssetTypes, type AssetTypeVault } from '@src/hooks/use-asset-types';
import { useSystemTools } from '@src/hooks/use-system-tools';
import {
  INDEX_BUILD_LABEL,
  INDEX_PROMPT_DESCRIPTION,
  INDEX_PROMPT_TITLE,
} from '@src/components/search-index/index-copy';
import type { SearchRow } from '@src/hooks/search-row';
// Side-effect column registrations
import '@src/components/assets/columns/assetColumns';
import '@src/components/assets/columns/bookmarkColumns';
import '@src/components/assets/columns/skillColumns';
import '@src/components/assets/columns/agentColumns';
import '@src/components/assets/columns/taskColumns';
import '@src/components/assets/columns/projectColumns';
import '@src/components/assets/columns/planColumns';
import '@src/components/assets/columns/claudeMemoryColumns';
import '@src/components/assets/columns/claudeMdColumns';
import '@src/components/assets/columns/claudeRulesColumns';
// Side-effect filter registrations
import '@src/components/assets/filters/taskFilters';

interface ParsedAssetPointer {
  mode: 'editor' | 'list' | 'folder' | 'wiki' | 'fs' | 'projectHome' | null;
  typeName: string | null;
  /** Only set when mode === 'folder'. */
  folderTypeid: string | null;
  /** Only set when mode === 'folder'. VFS relPath under the typeid. */
  folderRelPath: string | null;
  /** Only set when mode === 'wiki'. Decoded link target name. */
  wikiName: string | null;
  /** Only set when mode === 'wiki'. The space the name resolves within (default @local). */
  wikiSpace: string | null;
  /** Only set when mode === 'fs'. Canonical filesystem identity. */
  fsVfsPath: VFSPath | null;
}

function parseAssetPointer(pointer: string | undefined): ParsedAssetPointer {
  const empty: ParsedAssetPointer = {
    mode: null,
    typeName: null,
    folderTypeid: null,
    folderRelPath: null,
    wikiName: null,
    wikiSpace: null,
    fsVfsPath: null,
  };
  if (!pointer) return empty;
  if (pointer === (AssetMode.PROJECT_HOME as string)) {
    return { ...empty, mode: 'projectHome' };
  }
  if (pointer.startsWith('editor/')) {
    return { ...empty, mode: 'editor' };
  }
  const fsVfsPath = DockPointer.parseAssetFsPointer(pointer);
  if (fsVfsPath !== null) {
    return { ...empty, mode: 'fs', fsVfsPath };
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
    try {
      name = decodeURIComponent(raw);
    } catch {
      /* keep raw */
    }
    return {
      ...empty,
      mode: 'wiki',
      typeName: 'markdown',
      wikiName: name || null,
      wikiSpace: space || DEFAULT_WIKI_SPACE,
    };
  }
  return empty;
}

/** Given a parsed folder pointer and a list of vaults, return the absolute
 *  filesystem path of the folder (for the parent_path API filter). */
function resolveFolderAbsPath(typeid: string, relPath: string, vaults: AssetTypeVault[]): string | null {
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
  const vault = vaults.find(
    (v) => v.typeid === typeid && (relPath === v.relPath || relPath.startsWith(v.relPath + (v.relPath ? '/' : ''))),
  );
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
  const { t } = useLingui();
  if (crumbs.length === 0) return null;
  return (
    <div className="flex items-center gap-1 border-b px-3 py-2 text-xs" data-testid="asset-list-breadcrumb">
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
                    <BreadcrumbLink className="cursor-pointer" onClick={() => onNavigate(c.pointer)}>
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
        title={t`Clear folder filter`}
        aria-label={t`Clear folder filter`}
        data-testid="asset-list-breadcrumb-clear"
        className="ms-auto flex h-5 w-5 items-center justify-center rounded hover:bg-muted"
      >
        <X className="h-3 w-3 text-muted-foreground" />
      </button>
    </div>
  );
}

export function AssetsPage() {
  const { t } = useLingui();
  const { currentDock, navigation } = useDockNavigation();
  const { types: allTypes } = useAssetTypes({ vibeAsStandard: true });
  const { busy, resetAndRescan } = useSystemTools();

  const [refreshKey, setRefreshKey] = useState(0);
  const [newTypeTarget, setNewTypeTarget] = useState<string | null>(null);
  const [newTypeDialogOpen, setNewTypeDialogOpen] = useState(false);
  const currentProjectId = dataContext.project?.id ?? null;
  // When hosted under `/dock/project/<id>`, the project id comes from the URL.
  // The first segment of the pointer is the projectId; the rest is the same
  // sub-pointer shape AssetsPage already uses under `/dock/assets/<sub>`.
  const isProjectView = currentDock?.viewType === ViewType.PROJECT;
  const { projectId: urlProjectId, assetSubPointer } = isProjectView
    ? DockPointer.splitProjectPointer(currentDock?.pointer)
    : { projectId: null, assetSubPointer: currentDock?.pointer ?? '' };
  // On a project page, scope is *preselected* to that project (not locked) — the
  // user can still switch to All/User/Selected. `projectSeedScope` is that
  // preselection: it seeds the initial scope, scopes the project index status,
  // and re-applies when navigating between projects.
  const projectSeedScope = useMemo(() => (urlProjectId ? defaultScopeFilter(urlProjectId) : null), [urlProjectId]);
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
  /** The project THIS URL pins — null unless the scope is a single project. */
  const urlScopeProjectId = pinnedProjectId(urlScope);
  // The project the scope filter points at: the URL project on a project page,
  // the explicit project scope on an assets page, else the context project.
  // Drives the Project mode + its tooltip name.
  const scopeProjectId = urlProjectId ?? urlScopeProjectId ?? currentProjectId;
  // The scoped project entity. Drives the "Delete project" header action (which
  // gates itself on `isProjectView`) and the folder Share — the latter also runs
  // in the assets dock, so this resolves for any scoped project, not just a
  // project page.
  const projectTypeId = useMemo<TypeId | null>(
    () => (scopeProjectId ? new TypeId('project', scopeProjectId) : null),
    [scopeProjectId],
  );
  const { data: projectEntity } = useEntity<Project>(projectTypeId);
  const handleDeleteProject = useCallback(() => {
    const proj = projectEntity;
    if (!proj) return;
    const name = proj.displayName ?? 'this project';
    const path = proj.fs_storage_mount_path;
    showDeleteAssetModal({
      name,
      description:
        'This permanently deletes the project and everything in it — all indexed ' +
        'records and their children, and the project folder on disk' +
        (path ? ` (${path})` : '') +
        '. This cannot be undone.',
      onConfirm: async () => {
        await proj.deleteWithChildren();
      },
      onAfterDelete: () => {
        notify.success({ title: t`Project deleted`, message: name });
        navigation.closeDock();
      },
    });
  }, [projectEntity, navigation]);
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
  const editorPointer = useMemo<AssetDocPointer | null>(() => {
    if (!effectivePointer.startsWith('editor/')) return null;
    try {
      const p = AssetDocPointer.parse(effectivePointer);
      p.validate();
      return p;
    } catch {
      return null;
    }
  }, [effectivePointer]);
  const openAssetTypeId = useMemo<TypeId | null>(() => {
    if (
      editorPointer &&
      editorPointer.editor !== AssetEditor.CODE &&
      editorPointer.method === AssetRoutingMethod.TYPEID
    ) {
      return new TypeId(editorPointer.value);
    }
    return null;
  }, [editorPointer]);
  const { data: openAsset } = useEntity(openAssetTypeId);
  const openAssetBucket = useMemo<AssetScopeBucket>(
    () => assetScopeBucket(openAsset as { scope?: string | null; project_id?: string | null } | null),
    [openAsset],
  );
  // The open asset's bucket auto-union stays on in the body; manual scope edits
  // (and their per-asset suppression) live in the navigator (`useAssetsModel`).
  const effectiveFilter = useMemo<AssetFilter>(() => {
    const scope = openAssetBucket ? unionAssetBucket(urlScope, openAssetBucket) : urlScope;
    return { ...assetFilter, scope };
  }, [assetFilter, urlScope, openAssetBucket]);

  // Index state comes from the project record's own ``.hash`` (the project IS a
  // record). The header no longer drives indexing; this only feeds the
  // never-indexed empty state below.
  const { state: idxState, refresh: refreshIdxStatus } = useIndexStatus(projectSeedScope ?? undefined);
  // Canonical "nothing indexed yet" signal. `idxState` is already scope-aware
  // (project-scoped in project view, unscoped in the assets dock). The empty
  // state is Advanced-only: indexing is plumbing, so project home shows its own
  // surface instead of a build prompt in the lower modes.
  const neverIndexed = idxState.phase === 'ready' && idxState.status.never_indexed;
  const isAdvanced = useIsAdvanced();

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

  // URL-first scope write: scope is a dock option (serialized once, in
  // lib/scope-filter). Writing the URL is the single source of truth —
  // `urlScope` re-derives it on the next render.
  const openScoped = useCallback(
    (scope: ScopeFilter) => {
      const base = currentDock ?? DockPointer.forAssetList('all');
      navigation.openDock(base.withScopeFilter(scope));
    },
    [currentDock, navigation],
  );

  // Asset-shaped pointers (`forAssetEditor`, `forAssetFolder`, `forAssetList`)
  // open at `/dock/assets/<sub>`. Under `/dock/project/<id>` we must rebase
  // them onto the project URL or every tree click, breadcrumb, or row click
  // would jump out of the project shell.
  const navigateAsset = useCallback(
    (p: DockPointer) => {
      // Every in-assets navigation (type click, folder, breadcrumb, row→editor)
      // stays in the SAME scope-keyed tab: re-stamp the current scope onto the
      // freshly-built (scope-less) pointer so the assets tabHash is unchanged and
      // the scope isn't dropped from the URL.
      navigation.openDock(p.withScopeFilter(urlScope));
    },
    [navigation, urlScope],
  );

  const {
    mode,
    typeName: selectedType,
    folderTypeid,
    folderRelPath,
    wikiName,
    wikiSpace,
    fsVfsPath,
  } = parseAssetPointer(effectivePointer);
  const fsRelPath = fsVfsPath?.entitySubPath ?? null;
  const isEditorMode = mode === 'editor';
  const isFolderMode = mode === 'folder';
  const isWikiMode = mode === 'wiki';
  const isFsMode = mode === 'fs';
  const isProjectHomeMode = isProjectHomeSurface({
    isProjectView,
    pointer: effectivePointer,
    scopedProjectId: isProjectView ? scopeProjectId : urlScopeProjectId,
  });

  // The folder the header's Share acts on: the context folder CONTAINING the
  // browsed path when there is one (only its root is a repo — an `fs/` pointer
  // addresses any depth), else the browsed directory itself. Same resolution the
  // body's browser uses — see useContextFolderForRel.
  const containingFolder = useContextFolderForRel(scopeProjectId, fsRelPath ?? '');

  const creatableTypes = useMemo(
    () => new Set(allTypes.filter((t) => t.creatable).map((t) => t.type_name)),
    [allTypes],
  );

  const handleNew = useCallback((type: string) => {
    setNewTypeTarget(type);
    setNewTypeDialogOpen(true);
  }, []);

  // Resolve the absolute path of the selected folder (from vault metadata),
  // and the effective record_type + filter for the right-panel list view.
  const markdownVaults = useMemo(() => {
    const md = allTypes.find((t) => t.type_name === 'markdown');
    return md?.vaults ?? [];
  }, [allTypes]);

  const folderAbsPath =
    isFolderMode && folderTypeid && folderRelPath !== null
      ? resolveFolderAbsPath(folderTypeid, folderRelPath, markdownVaults)
      : null;

  const folderCrumbs =
    isFolderMode && folderTypeid && folderRelPath !== null
      ? buildFolderBreadcrumbs(folderTypeid, folderRelPath, markdownVaults)
      : [];

  const listFilter = useMemo<AssetFilter>(() => {
    if (isFolderMode && folderAbsPath) {
      return { ...effectiveFilter, parentPath: folderAbsPath };
    }
    return effectiveFilter;
  }, [effectiveFilter, isFolderMode, folderAbsPath]);

  const handleNewConfirm = useCallback(
    async (name: string) => {
      if (!name.trim() || !newTypeTarget) return;
      const descriptor = getDescriptor(newTypeTarget);
      if (!descriptor) {
        notify.error({ title: t`Cannot create ${newTypeTarget}` });
        setNewTypeTarget(null);
        return;
      }
      try {
        const res = await descriptor.create({ project: dataContext.project ?? null, name });
        notify.success({ title: i18n._(res.toastTitle) });
        if (res.pointer) {
          navigateAsset(res.pointer);
          setNewTypeTarget(null);
          return;
        }
        setRefreshKey((k) => k + 1);
      } catch (err) {
        console.error('[AssetsPage] Failed to create:', err);
        notify.error({ title: t`Failed to create` });
      }
      setNewTypeTarget(null);
    },
    [newTypeTarget, navigateAsset],
  );

  const handleRowClick = useCallback(
    (result: SearchRow) => {
      // Projects open in their collaboration space (the "project room"), not
      // the asset editor — the editor router has no page for project entities.
      if (result.record_type === (RecordType.PROJECT as string)) {
        navigation.openDock(DockPointer.forProject(result.record_id));
        return;
      }
      const path = result.asset_ref;
      if (!path || !path.startsWith('/')) {
        notify.error({
          title: t`Asset has no file on disk`,
          message: t`${result.name || result.record_id} is indexed without a valid source path and cannot be opened.`,
        });
        return;
      }
      navigateAsset(DockPointer.forAssetEditor(result.record_type, path));
    },
    [navigateAsset, navigation],
  );

  const handleProjectFilter = useCallback(
    async (label: string) => {
      try {
        const data = (await apiClient.get('/search?record_type=project&limit=200')) as {
          results?: { record_id: string; name: string }[];
        } | null;
        const projects = data?.results ?? [];
        const match = projects.find((p) => {
          const lastSeg = p.name.replace(/\/$/, '').split('/').filter(Boolean).pop() ?? p.name;
          return lastSeg === label || p.name === label;
        });
        if (match) {
          setAssetFilter({ ...DEFAULT_ASSET_FILTER });
          openScoped(projectScope(match.record_id));
        }
      } catch {
        // ignore
      }
    },
    [openScoped],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header — BROWSING modes only.
          The editor has none: its name, path and actions all live in the top
          navigation bar now (the crumb's details popover carries the path and
          the reveal actions), and rendering them here too put the same identity
          on screen twice, ~60px apart. What remains below is the browser's own
          chrome — the Assets label, the folder share, the project delete —
          which the bar has no equivalent for. */}
      {!isEditorMode && (
        <div className="flex h-[52px] flex-shrink-0 items-center gap-1 border-b px-3" data-testid="assets-page-header">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BookOpen className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {/* A context folder gets its own name as the pane title;
                  everything else keeps Assets. */}
                {isFsMode && fsRelPath ? (
                  fsRelPath.replace(/\/+$/, '').split('/').pop() || <Trans>Assets</Trans>
                ) : isProjectView ? (
                  <Trans>Project assets</Trans>
                ) : (
                  <Trans>Assets</Trans>
                )}
              </div>
            </div>
          </div>
          <div className="ms-auto flex items-center gap-2">
            {/* Share the folder this pane is browsing. Only an fs pointer has a
              folder to share; the button hides itself for a legacy dir with no
              linked Folder entity. Search lives on the list's own bar below,
              and indexing is plumbing — neither belongs in the header. */}
            {isFsMode && containingFolder && (
              <ShareContextFolderButton folder={containingFolder} project={projectEntity} />
            )}
            {isProjectView && projectEntity && (
              <Button
                variant="ghost"
                size="sm"
                className="h-9 shrink-0 gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={handleDeleteProject}
                data-testid="project-delete"
              >
                <Trash2 className="h-4 w-4" />
                <Trans>Delete project</Trans>
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Sidebar (asset tree + scope filter) moved to the shared left-menu
            slot — see AssetsNavigator / NavigatorSlot. This body keeps the
            header + content router only. */}
        {/* Main content: editor when in editor mode, list view otherwise */}
        <div className="min-w-0 flex-1">
          {isFsMode && fsVfsPath ? (
            <ContextFolderBrowser vfsPath={fsVfsPath} onNavigate={navigateAsset} projectId={scopeProjectId} />
          ) : isWikiMode && wikiName ? (
            <WikiResolveView
              name={wikiName}
              space={wikiSpace ?? DEFAULT_WIKI_SPACE}
              fragment={currentDock?.options?.[WIKI_FRAGMENT_PARAM]}
            />
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
                    onProjectFilter={(label) => void handleProjectFilter(label)}
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
              onProjectFilter={(label) => void handleProjectFilter(label)}
            />
          ) : shouldShowIndexPrompt({ neverIndexed, isAdvanced, isProjectHomeMode }) ? (
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
          ) : isProjectHomeMode ? (
            <ProjectHome spawnProjectId={scopeProjectId} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Trans>Select a type to browse</Trans>
            </div>
          )}
        </div>
      </div>

      <InputDialog
        open={newTypeDialogOpen}
        onOpenChange={setNewTypeDialogOpen}
        title={`New ${newTypeTarget ?? ''}`}
        description={`Enter a name for the new ${newTypeTarget ?? 'item'}.`}
        placeholder={t`Name`}
        confirmLabel={t`Create`}
        onConfirm={(name) => void handleNewConfirm(name)}
      />
    </div>
  );
}

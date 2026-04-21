import { AssetEditorRouter, hasEditor } from '@src/components/assets/editor/AssetEditorRouter';
import { InputDialog } from '@src/components/ui/input-dialog';
import { getDescriptor } from '@src/components/quick-create';
import { useToast } from '@src/hooks/use-toast';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dataContext, RecordType } from '@sdk';
import apiClient from '@sdk/client';
import { BookOpen, ChevronRight, PanelLeft, PanelLeftClose, X } from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@src/components/ui/breadcrumb';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AssetFilter, AssetScope } from './assetFilter';
import { DEFAULT_ASSET_FILTER } from './assetFilter';
import { ScopeFilterBar } from './ScopeFilterBar';
import { AssetListView } from './AssetListView';
import { BrowseableTree } from '@src/components/browseable-tree';
import { assetTypeRoot } from '@src/components/browseable-tree/adapters/assetTypeRoot';
import { markdownFolderRoot } from '@src/components/browseable-tree/adapters/markdownFolderRoot';
import { useAssetTypes, type AssetTypeVault } from '@src/hooks/use-asset-types';
import { useSystemTools } from '@src/hooks/use-system-tools';
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
import '@src/components/assets/filters/assetFilters';
import '@src/components/assets/filters/taskFilters';

interface ParsedAssetPointer {
  mode: 'editor' | 'list' | 'folder' | null;
  typeName: string | null;
  /** Only set when mode === 'folder'. */
  folderTypeid: string | null;
  /** Only set when mode === 'folder'. VFS relPath under the typeid. */
  folderRelPath: string | null;
}

function parseAssetPointer(pointer: string | undefined): ParsedAssetPointer {
  if (!pointer) return { mode: null, typeName: null, folderTypeid: null, folderRelPath: null };
  if (pointer.startsWith('editor/')) {
    // Preserve legacy behavior: typeName isn't surfaced in editor mode today.
    return { mode: 'editor', typeName: null, folderTypeid: null, folderRelPath: null };
  }
  if (pointer.startsWith('list/')) {
    return {
      mode: 'list',
      typeName: pointer.slice('list/'.length) || null,
      folderTypeid: null,
      folderRelPath: null,
    };
  }
  if (pointer.startsWith('folder/')) {
    const folder = DockPointer.parseAssetFolderPointer(pointer);
    if (folder) {
      return {
        mode: 'folder',
        typeName: folder.typeName,
        folderTypeid: folder.typeid,
        folderRelPath: folder.relPath,
      };
    }
  }
  return { mode: null, typeName: null, folderTypeid: null, folderRelPath: null };
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

const HIDDEN_TYPES = new Set<string>([RecordType.ASSET, RecordType.ANNOTATION]);

const SIDEBAR_COLLAPSED_KEY = 'wiki:sidebar-collapsed';

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
  const { toast } = useToast();
  const { currentDock, navigation } = useDockNavigation();
  const { types: allTypes, isLoading: typesLoading } = useAssetTypes();
  const { indexType } = useSystemTools();

  const [refreshKey, setRefreshKey] = useState(0);
  const [newTypeTarget, setNewTypeTarget] = useState<string | null>(null);
  const [newTypeDialogOpen, setNewTypeDialogOpen] = useState(false);
  const [assetFilter, setAssetFilter] = useState<AssetFilter>(DEFAULT_ASSET_FILTER);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), []);

  const handleScopeChange = useCallback((scope: AssetScope) => {
    setAssetFilter(prev => ({
      ...prev,
      scope,
      projectIds: scope === 'project' ? prev.projectIds : [],
    }));
  }, []);

  const handleProjectIdsChange = useCallback((ids: string[]) => {
    setAssetFilter(prev => ({ ...prev, projectIds: ids }));
  }, []);

  const handleIncludeSystemChange = useCallback((next: boolean) => {
    setAssetFilter(prev => ({ ...prev, includeSystem: next }));
  }, []);

  const {
    mode,
    typeName: selectedType,
    folderTypeid,
    folderRelPath,
  } = parseAssetPointer(currentDock?.pointer);
  const isEditorMode = mode === 'editor';
  const isFolderMode = mode === 'folder';

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

  const wikiRoots = useMemo(
    () =>
      visibleTypes.map((t) => {
        if (t.type_name === 'markdown') {
          return markdownFolderRoot(t, {
            indexType,
            onNew: handleNew,
            onScanComplete: handleScanComplete,
          });
        }
        return assetTypeRoot(t, {
          indexType,
          onNew: handleNew,
          creatableTypes,
          filter: assetFilter,
          onScanComplete: handleScanComplete,
        });
      }),
    [visibleTypes, indexType, handleNew, creatableTypes, assetFilter, handleScanComplete],
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
      return { ...assetFilter, parentPath: folderAbsPath };
    }
    return assetFilter;
  }, [assetFilter, isFolderMode, folderAbsPath]);

  const handleNewConfirm = useCallback(async (name: string) => {
    if (!name.trim() || !newTypeTarget) return;
    const descriptor = getDescriptor(newTypeTarget);
    if (!descriptor) {
      toast({ title: `Cannot create ${newTypeTarget}`, variant: 'destructive' });
      setNewTypeTarget(null);
      return;
    }
    try {
      const res = await descriptor.create({ project: dataContext.project ?? null, name });
      toast({ title: res.toastTitle });
      if (res.pointer) {
        navigation.openDock(res.pointer);
        setNewTypeTarget(null);
        return;
      }
      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error('[AssetsPage] Failed to create:', err);
      toast({ title: 'Failed to create', variant: 'destructive' });
    }
    setNewTypeTarget(null);
  }, [newTypeTarget, navigation, toast]);

  const handleRowClick = useCallback((result: SearchResult) => {
    const path = result.source_path;
    if (!path || !path.startsWith('/')) {
      toast({
        title: 'Asset has no file on disk',
        description: `${result.name || result.record_id} is indexed without a valid source path and cannot be opened.`,
        variant: 'destructive',
      });
      return;
    }
    navigation.openDock(DockPointer.forAssetEditor(result.record_type, path));
  }, [navigation, toast]);

  const handleProjectFilter = useCallback(async (label: string) => {
    try {
      const data = await apiClient.get('/search?record_type=project&limit=200') as { results?: { record_id: string; name: string }[] } | null;
      const projects = data?.results ?? [];
      const match = projects.find((p) => {
        const lastSeg = p.name.replace(/\/$/, '').split('/').filter(Boolean).pop() ?? p.name;
        return lastSeg === label || p.name === label;
      });
      if (match) {
        setAssetFilter({ ...DEFAULT_ASSET_FILTER, scope: 'project', projectIds: [match.record_id] });
      }
    } catch {
      // ignore
    }
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-[52px] flex-shrink-0 items-center gap-1 border-b px-3">
        <button
          type="button"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? 'Show wiki tree' : 'Hide wiki tree'}
          aria-label={sidebarCollapsed ? 'Show wiki tree' : 'Hide wiki tree'}
          className="flex h-7 w-7 items-center justify-center rounded hover:bg-muted"
        >
          {sidebarCollapsed ? (
            <PanelLeft className="h-4 w-4 text-muted-foreground" />
          ) : (
            <PanelLeftClose className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        <span className="ml-1 text-sm font-medium">Wiki</span>
        <div className="ml-auto">
          <ScopeFilterBar
            scope={assetFilter.scope}
            projectIds={assetFilter.projectIds}
            onScopeChange={handleScopeChange}
            onProjectIdsChange={handleProjectIdsChange}
            includeSystem={assetFilter.includeSystem ?? false}
            onIncludeSystemChange={handleIncludeSystemChange}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Type sidebar — collapsible push drawer */}
        <div
          className={`flex-shrink-0 overflow-hidden border-r transition-[width] duration-200 ease-out ${
            sidebarCollapsed ? 'w-0' : 'w-56'
          }`}
          aria-hidden={sidebarCollapsed}
        >
          <div className="h-full w-56 overflow-y-auto">
            <BrowseableTree
              roots={wikiRoots}
              activePointer={currentDock ?? null}
              isLoading={typesLoading && wikiRoots.length === 0}
              onNavigate={(p) => navigation.openDock(p)}
            />
          </div>
        </div>

        {/* Main content: editor when in editor mode, list view otherwise */}
        <div className="min-w-0 flex-1">
          {isEditorMode && currentDock?.pointer ? (
            <AssetEditorRouter pointer={currentDock.pointer} />
          ) : isFolderMode ? (
            <div className="flex h-full flex-col">
              <FolderBreadcrumb
                crumbs={folderCrumbs}
                onNavigate={(p) => navigation.openDock(p)}
                onClear={() => navigation.openDock(DockPointer.forAssetList('markdown'))}
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
          ) : selectedType ? (
            <AssetListView
              recordType={selectedType}
              onNew={creatableTypes.has(selectedType) ? () => handleNew(selectedType) : undefined}
              refreshKey={refreshKey}
              onRowClick={hasEditor(selectedType) ? handleRowClick : undefined}
              filter={assetFilter}
              onFilterChange={setAssetFilter}
              onProjectFilter={handleProjectFilter}
            />
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
    </div>
  );
}

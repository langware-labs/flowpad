import { AssetEditorRouter, hasEditor } from '@src/components/assets/editor/AssetEditorRouter';
import { InputDialog } from '@src/components/ui/input-dialog';
import { getDescriptor } from '@src/components/quick-create';
import { useToast } from '@src/hooks/use-toast';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { dataContext, RecordType } from '@sdk';
import apiClient from '@sdk/client';
import { BookOpen, PanelLeft, PanelLeftClose } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AssetFilter, AssetScope } from './assetFilter';
import { DEFAULT_ASSET_FILTER } from './assetFilter';
import { ScopeFilterBar } from './ScopeFilterBar';
import { AssetListView } from './AssetListView';
import { BrowseableTree } from '@src/components/browseable-tree';
import { assetTypeRoot } from '@src/components/browseable-tree/adapters/assetTypeRoot';
import { useAssetTypes } from '@src/hooks/use-asset-types';
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

function parseAssetPointer(pointer: string | undefined): { mode: 'editor' | 'list' | null; typeName: string | null } {
  if (!pointer) return { mode: null, typeName: null };
  if (pointer.startsWith('editor/')) return { mode: 'editor', typeName: null };
  if (pointer.startsWith('list/')) return { mode: 'list', typeName: pointer.slice('list/'.length) || null };
  return { mode: null, typeName: null };
}

const HIDDEN_TYPES = new Set<string>([RecordType.ASSET, RecordType.ANNOTATION]);

const SIDEBAR_COLLAPSED_KEY = 'wiki:sidebar-collapsed';

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

  const { mode, typeName: selectedType } = parseAssetPointer(currentDock?.pointer);
  const isEditorMode = mode === 'editor';

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
      visibleTypes.map((t) =>
        assetTypeRoot(t, {
          indexType,
          onNew: handleNew,
          creatableTypes,
          filter: assetFilter,
          onScanComplete: handleScanComplete,
        }),
      ),
    [visibleTypes, indexType, handleNew, creatableTypes, assetFilter, handleScanComplete],
  );

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
    navigation.openDock(DockPointer.forAssetEditor(result.record_type, result.source_path));
  }, [navigation]);

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

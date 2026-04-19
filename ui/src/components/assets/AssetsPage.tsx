import { AssetEditorRouter, hasEditor } from '@src/components/assets/editor/AssetEditorRouter';
import { InputDialog } from '@src/components/ui/input-dialog';
import { useToast } from '@src/hooks/use-toast';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Agent, dataContext, fsManager, Skill, Task, Workflow } from '@sdk';
import { ComputeNode } from '@sdk/entities/compute-node';
import apiClient from '@sdk/client';
import { BookOpen } from 'lucide-react';
import React, { useCallback, useState } from 'react';
import type { AssetFilter, AssetScope } from './assetFilter';
import { DEFAULT_ASSET_FILTER } from './assetFilter';
import { ScopeFilterBar } from './ScopeFilterBar';
import { AssetTypeSidebar } from './AssetTypeSidebar';
import { AssetListView } from './AssetListView';
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

const CREATABLE_TYPES = new Set(['skill', 'agent', 'workflow', 'task', 'markdown']);

function parseAssetPointer(pointer: string | undefined): { mode: 'editor' | 'list' | null; typeName: string | null } {
  if (!pointer) return { mode: null, typeName: null };
  if (pointer.startsWith('editor/')) return { mode: 'editor', typeName: null };
  if (pointer.startsWith('list/')) return { mode: 'list', typeName: pointer.slice('list/'.length) || null };
  return { mode: null, typeName: null };
}

export function AssetsPage() {
  const { toast } = useToast();
  const { currentDock, navigation } = useDockNavigation();

  const [refreshKey, setRefreshKey] = useState(0);
  const [newTypeTarget, setNewTypeTarget] = useState<string | null>(null);
  const [newTypeDialogOpen, setNewTypeDialogOpen] = useState(false);
  const [assetFilter, setAssetFilter] = useState<AssetFilter>(DEFAULT_ASSET_FILTER);

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

  const handleNew = useCallback((type: string) => {
    setNewTypeTarget(type);
    setNewTypeDialogOpen(true);
  }, []);

  const handleNewConfirm = useCallback(async (name: string) => {
    if (!name.trim() || !newTypeTarget) return;
    try {
      if (newTypeTarget === 'skill') {
        const scopeIds = dataContext.projectTypeId ? [dataContext.projectTypeId] : [];
        const skill = new Skill({ name: name.trim() });
        const saved = await skill.save(scopeIds);
        toast({ title: 'Skill created' });
        if (saved.source_path) {
          navigation.openDock(DockPointer.forAssetEditor('skill', saved.source_path));
          return;
        }
      } else if (newTypeTarget === 'agent') {
        const agent = new Agent({ name: name.trim() });
        const saved = await agent.save([]);
        toast({ title: 'Agent created' });
        if (saved.source_path) {
          navigation.openDock(DockPointer.forAssetEditor('agent', saved.source_path));
          return;
        }
      } else if (newTypeTarget === 'workflow') {
        const saved = await Workflow.create(name.trim());
        toast({ title: 'Workflow created' });
        if (saved.source_vfs_path) {
          navigation.openDock(DockPointer.forAssetEditor('workflow', saved.source_vfs_path));
          return;
        }
      } else if (newTypeTarget === 'task') {
        const task = new Task({ title: name.trim() });
        const saved = await task.save();
        toast({ title: 'Task created' });
        navigation.openDock(DockPointer.forTasks(saved.id));
        return;
      } else if (newTypeTarget === 'markdown') {
        const computeNode = await ComputeNode.getById('@local');
        if (!computeNode) throw new Error('No local compute node');
        const mountPath = dataContext.project?.fs_storage_mount_path ?? '';
        const vfsBase = mountPath.startsWith('/') ? mountPath.slice(1) : mountPath;
        const safeName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        const vfsPath = vfsBase
          ? `${vfsBase}/.claude/docs/${safeName}.md`
          : `.claude/docs/${safeName}.md`;
        const content = `---\ntitle: ${name.trim()}\n---\n\n# ${name.trim()}\n`;
        await fsManager.writeFile(computeNode.typeId, vfsPath, content);
        toast({ title: 'Markdown created' });
        navigation.openDock(DockPointer.forAssetEditor('markdown', vfsPath));
        return;
      }
      setRefreshKey(k => k + 1);
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

  // Editor mode: show the asset editor
  if (isEditorMode && currentDock?.pointer) {
    return <AssetEditorRouter pointer={currentDock.pointer} />;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex h-[52px] flex-shrink-0 items-center border-b px-3">
        <BookOpen className="h-4 w-4 text-muted-foreground" />
        <span className="ml-2 text-sm font-medium">Wiki</span>
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
        {/* Type sidebar */}
        <div className="w-56 flex-shrink-0 overflow-y-auto border-r">
          <AssetTypeSidebar
            selected={selectedType}
            onSelect={(t) => navigation.openAssetList(t)}
            onNew={handleNew}
            onScanComplete={(type) => { if (type === selectedType) setRefreshKey(k => k + 1); }}
            creatableTypes={CREATABLE_TYPES}
          />
        </div>
        {/* List view */}
        <div className="min-w-0 flex-1">
          {selectedType ? (
            <AssetListView
              recordType={selectedType}
              onNew={CREATABLE_TYPES.has(selectedType) ? () => handleNew(selectedType) : undefined}
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

import { FileText, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAssetSearch } from '@src/hooks/use-asset-search';
import type { AssetFilter } from '@src/components/assets/assetFilter';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { InputDialog } from '@src/components/ui/input-dialog';
import { MarkdownAsset, Project, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useToast } from '@src/hooks/use-toast';

interface Props {
  projectId: string | null;
}

export function DocsCategory({ projectId }: Props) {
  const { navigation } = useDockNavigation();
  const { toast } = useToast();

  // Resolve the project entity so we can read `system` for auto-opt-in.
  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );
  const { data: project } = useEntity<Project>(projectTypeId);
  const isSystemProject = !!project?.system;

  // Include-system toggle: auto-checked when browsing a system project's own
  // collab space (otherwise every doc there is invisible), otherwise off.
  const [includeSystem, setIncludeSystem] = useState<boolean>(isSystemProject);
  useEffect(() => {
    setIncludeSystem(isSystemProject);
  }, [isSystemProject]);

  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filter by the project's .claude/docs/ folder path rather than scope=project,
  // because the server's scope filter compares encoded path, not project UUID —
  // records under a system project wouldn't match. parent_path is unambiguous.
  const docsParentPath = useMemo(() => {
    const mount = project?.fs_storage_mount_path;
    if (!mount) return undefined;
    return `${mount.replace(/\/+$/, '')}/.claude/docs`;
  }, [project?.fs_storage_mount_path]);

  const filter = useMemo<AssetFilter>(
    () => ({
      query: '',
      scope: 'all',
      projectIds: [],
      tags: [],
      filters: {},
      parentPath: docsParentPath,
      includeSystem,
    }),
    [docsParentPath, includeSystem],
  );

  const { results, isLoading } = useAssetSearch({
    recordType: projectId && docsParentPath ? 'markdown' : null,
    filter,
    page: 1,
    pageSize: 50,
    refreshKey,
  });

  const handleCreate = useCallback(
    async (name: string) => {
      if (!name.trim() || !project) return;
      try {
        await MarkdownAsset.createInProject(project, name, '.claude/docs');
        toast({ title: 'Doc created' });
        setRefreshKey((k) => k + 1);
      } catch (err) {
        console.error('[DocsCategory] Create failed:', err);
        toast({ title: 'Failed to create doc', variant: 'destructive' });
      }
    },
    [project, toast],
  );

  if (!projectId) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No project linked</div>;
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 px-2 py-1">
        {!isSystemProject && (
          <label
            className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            title="Show docs from SDK-shipped system projects"
          >
            <input
              type="checkbox"
              className="h-3 w-3 rounded border-input"
              checked={includeSystem}
              onChange={(e) => setIncludeSystem(e.target.checked)}
            />
            Show system
          </label>
        )}
        <button
          type="button"
          onClick={() => setNewDialogOpen(true)}
          title="New doc"
          aria-label="New doc"
          className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {isLoading && results.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
      ) : results.length === 0 ? (
        <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No docs yet</div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {results.map((d) => (
            <li
              key={d.record_id}
              onClick={() => navigation.openDock(DockPointer.forAssetEditor('markdown', d.source_path))}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FileText className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{d.name}</span>
            </li>
          ))}
        </ul>
      )}

      <InputDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        title="New doc"
        description=".claude/docs/ under this project"
        placeholder="doc name"
        confirmLabel="Create"
        onConfirm={(name) => void handleCreate(name)}
      />
    </div>
  );
}

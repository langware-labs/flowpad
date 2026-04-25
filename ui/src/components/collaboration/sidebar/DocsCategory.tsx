import { FileText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAssetSearch } from '@src/hooks/use-asset-search';
import type { AssetFilter } from '@src/components/assets/assetFilter';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { Project, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import type { RoomTab } from '../RoomTabs';

interface Props {
  projectId: string | null;
  refreshKey?: number;
  /** When provided, doc clicks open a tab in the room rather than navigating away. */
  onOpenTab?: (tab: RoomTab) => void;
}

export function DocsCategory({ projectId, refreshKey = 0, onOpenTab }: Props) {
  const { navigation } = useDockNavigation();

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

  if (!projectId) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No project linked</div>;
  }

  // Only show the Show-system toggle for non-system projects (system projects
  // are auto-opted-in; toggling it off would leave the panel empty pointlessly).
  const showToggleRow = !isSystemProject;

  return (
    <div className="flex flex-col gap-0.5">
      {showToggleRow && (
        <label
          className="flex cursor-pointer items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
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

      {isLoading && results.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
      ) : results.length === 0 ? (
        <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No docs yet</div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {results.map((d) => (
            <li
              key={d.record_id}
              onClick={() => {
                if (onOpenTab && d.asset_ref) {
                  onOpenTab({
                    key: `markdown:${d.record_id}`,
                    type: 'markdown',
                    title: d.name || 'Untitled',
                    asset_ref: d.asset_ref,
                  });
                } else {
                  navigation.openDock(DockPointer.forAssetEditor('markdown', d.asset_ref));
                }
              }}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FileText className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{d.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

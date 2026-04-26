import { FileText } from 'lucide-react';
import { useMemo, useEffect, useState } from 'react';
import { Markdown, Project, QueryRequest, TypeId } from '@sdk';
import { useEntity, useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import type { RoomTab } from '../RoomTabs';

interface Props {
  projectId: string | null;
  /** When provided, doc clicks add a tab to RoomTabs in the room view. */
  onOpenTab?: (tab: RoomTab) => void;
}

interface DocRow {
  id: string;
  name?: string;
  asset_ref?: string;
  parent_path?: string;
  scope?: string;
}

const docsQuery = new QueryRequest({
  type: Markdown.type,
  scope: [],
  name: 'DocsCategory:markdown',
  query: null,
});

/**
 * Docs category — lists Markdown entities scoped to the current project's
 * ``.claude/docs/``. Reads from the entity DB (``useEntitiesQuery``); rows
 * created via ``Markdown.createInProject`` (which calls Entity.save()) land
 * in the cache synchronously. No indexer lag.
 */
export function DocsCategory({ projectId, onOpenTab }: Props) {
  const { navigation } = useDockNavigation();

  // Resolve project so we can filter docs to its `.claude/docs/`.
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

  const { data: rows = [], isLoading } = useEntitiesQuery<DocRow>(docsQuery);

  const items = useMemo(() => {
    const mount = project?.fs_storage_mount_path?.replace(/\/+$/, '') ?? '';
    if (!mount) return [];
    const folder = `${mount}/.claude/docs`;
    return rows.filter((r) => {
      if (r.parent_path !== folder) return false;
      // Match the original includeSystem behavior — exclude scope='system' rows
      // unless the toggle is on.
      if (!includeSystem && r.scope === 'system') return false;
      return true;
    });
  }, [rows, project?.fs_storage_mount_path, includeSystem]);

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

      {isLoading && items.length === 0 ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
      ) : items.length === 0 ? (
        <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No docs yet</div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((d) => (
            <li
              key={d.id}
              onClick={() => {
                if (!d.asset_ref) return;
                if (onOpenTab) {
                  onOpenTab({
                    key: `markdown:${d.id}`,
                    type: 'markdown',
                    title: typeof d.name === 'string' && d.name ? d.name : 'Untitled',
                    asset_ref: d.asset_ref,
                  });
                } else {
                  navigation.openDock(DockPointer.forAssetEditor('markdown', d.asset_ref));
                }
              }}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <FileText className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{typeof d.name === 'string' && d.name ? d.name : 'Untitled'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

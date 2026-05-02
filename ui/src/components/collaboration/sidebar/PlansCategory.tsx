import { ListChecks } from 'lucide-react';
import { useMemo } from 'react';
import { Plan, Project, QueryRequest, TypeId } from '@sdk';
import { useEntity, useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';

interface Props {
  projectId: string | null;
}

const plansQuery = new QueryRequest({
  type: 'plan',
  scope: [],
  name: 'PlansCategory:plans',
  query: null,
});

/**
 * Plans category — lists ClaudePlan entities. Backed by the entity DB
 * (``useEntitiesQuery``), so entries created via ``Entity.save()`` appear
 * instantly. Search-index lag is gone.
 */
export function PlansCategory({ projectId }: Props) {
  const { navigation } = useDockNavigation();

  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );
  const { data: project } = useEntity<Project>(projectTypeId);

  const { data: rows = [], isLoading } = useEntitiesQuery<Plan>(plansQuery);

  const items = useMemo(() => {
    const mount = project?.fs_storage_mount_path?.replace(/\/+$/, '') ?? '';
    if (!mount) return [];
    const folder = `${mount}/.claude/plans`;
    return rows.filter((r) => r.parent_path === folder);
  }, [rows, project?.fs_storage_mount_path]);

  if (!projectId) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No project linked</div>;
  }

  if (isLoading && items.length === 0) {
    return <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>;
  }

  if (items.length === 0) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No plans shared</div>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((p) => (
        <li
          key={p.id}
          onClick={() => p.asset_ref && navigation.openDock(DockPointer.forAssetEditor('plan', p.asset_ref))}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ListChecks className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{p.displayName}</span>
        </li>
      ))}
    </ul>
  );
}

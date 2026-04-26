import { config, Project, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useMemo } from 'react';

interface Props {
  projectId: string | null;
}

interface SkillRow {
  id: string;
  name?: string;
  asset_ref?: string;
  description?: string;
  system?: boolean;
}

/**
 * Skills category — lists Skill records whose folder lives under the
 * current project's `.claude/skills/`. Always passes `include_system=true`
 * so SDK-shipped system skills (e.g. flowpad-navigation, flow,
 * compile-workflow) appear when browsing the @flowpad_assistant project.
 *
 * Fetches via the graph router directly because `useEntitiesQuery` doesn't
 * expose the `include_system` flag the server respects for system records.
 */
export function SkillsCategory({ projectId }: Props) {
  const { navigation } = useDockNavigation();

  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );
  const { data: project } = useEntity<Project>(projectTypeId);
  const mount = project?.fs_storage_mount_path?.replace(/\/+$/, '') ?? '';

  const { data, isLoading } = useQuery<SkillRow[]>({
    queryKey: ['skills-include-system'],
    queryFn: async () => {
      const url = `${config.SERVER_URL}${config.API_PREFIXES.graph}/skill?include_system=true`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to load skills: ${resp.status}`);
      const body = await resp.json();
      return (body.data ?? []) as SkillRow[];
    },
    staleTime: 30_000,
  });

  const items = useMemo(() => {
    if (!mount || !data) return [] as SkillRow[];
    const prefix = `${mount}/.claude/skills/`;
    return data.filter((s) => (s.asset_ref ?? '').startsWith(prefix));
  }, [data, mount]);

  if (!projectId) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No project linked</div>;
  }

  if (isLoading && items.length === 0) {
    return <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>;
  }

  if (items.length === 0) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No skills yet</div>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((s) => (
        <li
          key={s.id}
          onClick={() => {
            if (!s.asset_ref) return;
            navigation.openDock(DockPointer.forAssetEditor('skill', s.asset_ref));
          }}
          title={s.description || s.asset_ref}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{typeof s.name === 'string' && s.name ? s.name : 'Untitled'}</span>
        </li>
      ))}
    </ul>
  );
}

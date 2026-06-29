import { apiClient, dataManager, Project, Skill, TypeId } from '@sdk';
import { useEntityOps } from '@sdk/react/hooks';
import { useEntity } from '@src/hooks/entity-hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { Trans } from '@lingui/react/macro';
import type { RoomTab } from '../RoomTabs';

// Module constant so the useEntityOps subscription array has a stable identity
// across renders (a fresh `[Skill.type]` each render would re-subscribe).
const SKILL_OP_TYPES = [Skill.type];

interface Props {
  projectId: string | null;
  /**
   * When provided (the standard case in CollaborationPage), skill clicks
   * open the editor in the project's RoomTabs strip — same in-place
   * experience as docs. Without it, fall back to dock navigation so the
   * sidebar still works if mounted outside CollaborationPage.
   */
  onOpenTab?: (tab: RoomTab) => void;
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
export function SkillsCategory({ projectId, onOpenTab }: Props) {
  const { navigation } = useDockNavigation();

  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );
  const { data: project } = useEntity<Project>(projectTypeId);
  const mount = project?.fs_storage_mount_path?.replace(/\/+$/, '') ?? '';

  const { data, isLoading } = useQuery<Skill[]>({
    queryKey: ['skills-include-system'],
    queryFn: async () => {
      const rows = await apiClient.get<Partial<Skill>[]>('/graph/skill?include_system=true');
      // Hydrate via the cache-deduping path; `new Skill(row)` self-registers in
      // the dataManager store and collides on every refetch (see use-entity-by-path).
      return (rows ?? []).map((row) => dataManager.updateEntityFromJson<Skill>(row));
    },
    staleTime: 30_000,
  });

  // Self-heal when a skill is created/updated/deleted elsewhere: the backend
  // broadcasts the entity op over the WS, so refetch the list (mirrors
  // use-entity-by-path's onEntityOp invalidation).
  const queryClient = useQueryClient();
  const onSkillOp = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['skills-include-system'] });
  }, [queryClient]);
  useEntityOps(SKILL_OP_TYPES, onSkillOp);

  const items = useMemo(() => {
    if (!mount || !data) return [] as Skill[];
    const prefix = `${mount}/.claude/skills/`;
    return data.filter((s) => (s.asset_ref ?? '').startsWith(prefix));
  }, [data, mount]);

  if (!projectId) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground"><Trans>No project linked</Trans></div>;
  }

  if (isLoading && items.length === 0) {
    return <div className="px-2 py-1.5 text-xs text-muted-foreground"><Trans>Loading…</Trans></div>;
  }

  if (items.length === 0) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground"><Trans>No skills yet</Trans></div>;
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((s) => (
        <li
          key={s.id}
          onClick={() => {
            if (!s.asset_ref) return;
            if (onOpenTab) {
              onOpenTab({
                key: `skill:${s.id}`,
                type: 'skill',
                title: s.displayName,
                asset_ref: s.asset_ref,
              });
            } else {
              navigation.openDock(DockPointer.forAssetEditor('skill', s.asset_ref));
            }
          }}
          title={s.description || s.asset_ref}
          className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{s.displayName}</span>
        </li>
      ))}
    </ul>
  );
}

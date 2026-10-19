import { useMemo } from 'react';
import type { ProjectListItem } from '@sdk';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { useProjects } from '@src/hooks/use-projects';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { hubProjectListItems } from './hub-project-list';

/**
 * The project list every picker shows: this machine's scan on a desk, or the
 * hub's own list on a hub-only server (a member there has no machine to scan).
 * One rule, so Open project and the dependency picker never drift apart.
 */
export function useProjectListSource({
  enabled,
  includeSystem = false,
  workspace,
}: {
  enabled: boolean;
  includeSystem?: boolean;
  workspace?: string;
}): { projects: ProjectListItem[]; isLoading: boolean; hub: boolean } {
  const hub = isHubOnly();
  const scan = useAllProjects({ enabled: enabled && !hub, includeSystem, workspace });
  const { projects: hubProjects, isLoading: isLoadingHub } = useProjects({ enabled: enabled && hub });
  const hubItems = useMemo(() => hubProjectListItems(hubProjects, includeSystem), [hubProjects, includeSystem]);
  return hub
    ? { projects: hubItems, isLoading: isLoadingHub, hub }
    : { ...scan, hub };
}

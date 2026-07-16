import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { ContactsGroup, Project, TypeId } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { useMembers } from '@src/hooks/use-members';
import { makeComputedGroup } from './computed-groups';

/**
 * "Project Members" — the current project's hub roster, sourced through the
 * canonical `useMembers` hook (cached participants + one-shot hub refresh,
 * like every other members surface). Includes the current user; consumers
 * filter/dedupe self where it matters (picker excludeUserId, the group-task
 * action drops the owner).
 */
function useProjectMembersGroup(enabled: boolean): ContactsGroup | null {
  const { t } = useLingui();
  const { project } = useProject(undefined, { enabled });
  const projectId = enabled ? project?.id : undefined;
  // Key the TypeId on the id string — entity instances (and their cached
  // typeId) are replaced on every watch push, which would refire useMembers.
  const projectTypeId = useMemo(() => (projectId ? new TypeId(Project.type, projectId) : null), [projectId]);
  const { members } = useMembers(projectTypeId);
  return useMemo(
    () => makeComputedGroup({ key: 'project-members', name: t`Project Members`, scopeId: projectId, members }),
    [projectId, members, t],
  );
}

/**
 * Registry of computed contacts groups — groups whose membership is derived
 * on the frontend from an entity roster instead of being stored. One hook
 * call per definition, unconditional (rules of hooks); adding a new computed
 * group (e.g. "Workspace Members") = one definition hook + one line here.
 */
export function useComputedGroups(enabled: boolean): ContactsGroup[] {
  const projectMembers = useProjectMembersGroup(enabled);
  return useMemo(() => [projectMembers].filter((g): g is ContactsGroup => g !== null), [projectMembers]);
}

import { canSetUpProjects, type ConversationParticipant, dataContext, type UserWarning, ViewType } from '@sdk';
import { projectOriginOf } from '@sdk/models/FSOrigin';
import { useLingui } from '@lingui/react/macro';
import { useAuth } from '@sdk/react/hooks';
import { useProjects } from '@src/hooks/use-projects';
import { useIncomingProjectStore } from '@src/store/use-incoming-project-store';
import { useMemo } from 'react';

/** The warning id of a shared project that is not set up here, one per project. */
export const sharedProjectWarningId = (projectId: string) => `shared-project-not-set-up:${projectId}`;

/** Who shared a project with you: the hub stamps `invited_by_name` on your own row of the cached roster. */
function sharerName(project: { members?: ConversationParticipant[] }): string | undefined {
  const own = project.members?.find((m) => typeof m.invited_by_name === 'string' && m.invited_by_name);
  return own?.invited_by_name as string | undefined;
}

/**
 * A shared project this desktop holds as a row with no files — its set-up was
 * skipped, closed, or never offered — as a footer warning whose click reopens
 * that set-up. Derived from the live project list, so it clears itself the
 * moment the project is set up; nothing is stored or dismissed. The project the
 * set-up dialog is showing right now is left out: it is already on screen.
 */
export function useSharedProjectWarnings(): UserWarning[] {
  const { t } = useLingui();
  const { projects } = useProjects();
  const { pendingProject, setPendingProject } = useIncomingProjectStore();
  const showing = pendingProject?.projectId;
  const { currentUser } = useAuth();
  const myId = currentUser?.id;
  // The hub (no disk) and agent boxes (nobody there) never warn.
  const canSetUp = canSetUpProjects(dataContext.caps);

  return useMemo(() => {
    const warnings: UserWarning[] = [];
    if (!canSetUp) return warnings;
    for (const project of projects ?? []) {
      if (project.fs_storage_mount_path || project.hidden || project.id === showing) continue;
      const gitOrigin = projectOriginOf(project);
      if (!gitOrigin) continue;
      const name = project.name || t`a shared project`;
      const setUp = () =>
        setPendingProject({ gitOrigin, projectName: name, senderName: sharerName(project), projectId: project.id });
      warnings.push({
        id: sharedProjectWarningId(project.id),
        icon: 'FolderX',
        color: 'yellow',
        message: t`${name} is not set up on this machine`,
        // Your own project on another machine was not "shared with you".
        description:
          myId && project.created_by === myId
            ? t`Its files are on another machine, not here yet.`
            : t`It was shared with you, but its files are not here yet.`,
        targetView: ViewType.HOME,
        onClick: setUp,
        action: { label: t`Set up`, onClick: setUp },
      });
    }
    return warnings;
  }, [canSetUp, myId, projects, showing, setPendingProject, t]);
}

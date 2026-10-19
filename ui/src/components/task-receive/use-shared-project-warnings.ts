import { type UserWarning, ViewType } from '@sdk';
import { projectOriginOf } from '@sdk/models/FSOrigin';
import { useLingui } from '@lingui/react/macro';
import { useProjects } from '@src/hooks/use-projects';
import { useIncomingProjectStore } from '@src/store/use-incoming-project-store';
import { useMemo } from 'react';

/** The warning id of a shared project that is not set up here, one per project. */
export const sharedProjectWarningId = (projectId: string) => `shared-project-not-set-up:${projectId}`;

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

  return useMemo(() => {
    const warnings: UserWarning[] = [];
    for (const project of projects ?? []) {
      if (project.fs_storage_mount_path || project.hidden || project.id === showing) continue;
      const gitOrigin = projectOriginOf(project);
      if (!gitOrigin) continue;
      const name = project.name || t`a shared project`;
      const setUp = () =>
        setPendingProject({ gitOrigin, projectName: name, senderName: 'Someone', projectId: project.id });
      warnings.push({
        id: sharedProjectWarningId(project.id),
        icon: 'FolderX',
        color: 'yellow',
        message: t`${name} is not set up on this machine`,
        description: t`It was shared with you, but its files are not here yet.`,
        targetView: ViewType.HOME,
        onClick: setUp,
        action: { label: t`Set up`, onClick: setUp },
      });
    }
    return warnings;
  }, [projects, showing, setPendingProject, t]);
}

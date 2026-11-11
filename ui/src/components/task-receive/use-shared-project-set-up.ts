import { canSetUpProjects, type ConversationParticipant, dataContext, isHiddenProject, type Project } from '@sdk';
import { projectOriginOf } from '@sdk/models/FSOrigin';
import { useLingui } from '@lingui/react/macro';
import { useContext } from '@sdk/react/hooks/useContext';
import { useProjects } from '@src/hooks/use-projects';
import {
  type IncomingProjectParams,
  isSetupDeclined,
  useIncomingProjectStore,
} from '@src/store/use-incoming-project-store';
import { useEffect, useMemo, useRef } from 'react';

/** Who shared a project with you: the hub stamps `invited_by_name` on your own row of the cached roster. */
function sharerName(project: { members?: ConversationParticipant[] }): string | undefined {
  const own = project.members?.find((m) => typeof m.invited_by_name === 'string' && m.invited_by_name);
  return own?.invited_by_name as string | undefined;
}

/** A shared project's set-up when this desktop holds it as a row with no files (and an origin to
 *  clone from); null for one set up here or an app-managed one. The one rule — the project list's
 *  "new" rows ask it too. */
export function sharedProjectSetUpOf(project: Project, fallbackName: string): IncomingProjectParams | null {
  if (project.fs_storage_mount_path || isHiddenProject(project)) return null;
  const gitOrigin = projectOriginOf(project);
  if (!gitOrigin) return null;
  return {
    gitOrigin,
    projectName: project.name || fallbackName,
    senderName: sharerName(project),
    projectId: String(project.id),
  };
}

/**
 * The current project's shared set-up (`sharedProjectSetUpOf`) — what the nav bar's glowing key
 * opens. Read from the live project list, so it is gone the moment the project is set up. Null
 * where nobody can set a project up (the hub, an agent's box).
 */
export function useSharedProjectSetUp(projectId: string | null | undefined): IncomingProjectParams | null {
  const { t } = useLingui();
  const { projects } = useProjects();
  const canSetUp = canSetUpProjects(dataContext.caps);

  return useMemo(() => {
    const project = projectId ? projects?.find((p) => String(p.id) === String(projectId)) : undefined;
    return canSetUp && project ? sharedProjectSetUpOf(project, t`a shared project`) : null;
  }, [canSetUp, projectId, projects, t]);
}

/**
 * Opening a shared project whose files are not here offers its set-up — once each time it is
 * opened, never over another set-up already on screen, and never after "Don't ask me again" (the
 * glowing key still opens it). Mounted once, app-wide.
 */
export function useOfferSharedProjectSetUpOnOpen(): void {
  const { project } = useContext();
  const projectId = project?.id ? String(project.id) : null;
  const setUp = useSharedProjectSetUp(projectId);
  const offeredFor = useRef<string | null>(null);

  useEffect(() => {
    if (!setUp) {
      offeredFor.current = null;
      return;
    }
    if (offeredFor.current === projectId) return;
    offeredFor.current = projectId;
    const { pendingProject, setPendingProject } = useIncomingProjectStore.getState();
    if (pendingProject || isSetupDeclined(setUp.projectId)) return;
    setPendingProject(setUp);
  }, [projectId, setUp]);
}

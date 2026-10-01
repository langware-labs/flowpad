import { isCompleteGitOrigin, isInstallableOrigin, Project, type GitOrigin } from '@sdk';
import { t } from '@lingui/core/macro';
import { DockPointer } from '@src/navigation/DockPointer';
import { consumeInboundParams, inboundParams } from '@src/navigation/inbound-link';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications/notify';
import { withHomePage } from '@src/project-home-page/home-page-state';
import { useIncomingProjectStore } from '@src/store/use-incoming-project-store';
import { useIncomingTaskStore } from '@src/store/use-incoming-task-store';
import { useEffect } from 'react';
import { IncomingProjectDialog } from './IncomingProjectDialog';
import { IncomingTaskDialog } from './IncomingTaskDialog';

/**
 * The `?action=open&…` deep-link handler — "someone sent you here to open X".
 *
 * Mounted ONCE at app level rather than inside a home page: the app has more
 * than one home (the standard landing and the vibe new-chat), a box opens on
 * whichever the user's view mode selects, and a handler that lives in only one
 * of them is dead on the other. That is exactly how a `/launch?repo=` sandbox
 * came up with no project: the box landed on the vibe home and the clone params
 * were dropped unread.
 *
 * Params (all optional except `action`): `setup_git=1` + `git_origin` → clone
 * that repo into a fresh, indexed Project — or, with `project_id` (a shared hub
 * project this box already holds as a file-less row), materialize THAT row in
 * place so both ends keep one id; `git_origin` + `task_id` → the task
 * pull/clone flow; `conversation_id` → open that conversation; `task_id` alone
 * → the tasks dock. From the desktop's `project/<id>/open` (which hydrates
 * the project first): `project_id` alone → it is installed here, open it;
 * `project_error=unavailable|unreachable` → say which, open nothing.
 */
/** The whole inbound payload — read together, scrubbed together, so no key can
 *  be left behind to replay on the next refresh. */
const DEEP_LINK_PARAMS = [
  'action',
  'fm',
  'conversation_id',
  'task_id',
  'setup_git',
  'project_id',
  'project_error',
  'title',
  'sender_name',
  'git_origin',
] as const;

/** True the first time this tab sees `projectId`'s set-up link, so the hop
 *  through `project/<id>/open` happens at most once and can never loop. */
function claimHydrateHop(projectId: string): boolean {
  const key = `flowpad:deep-link-hydrated:${projectId}`;
  try {
    if (window.sessionStorage.getItem(key)) return false;
    window.sessionStorage.setItem(key, '1');
    return true;
  } catch {
    return false;
  }
}

export function IncomingDeepLink() {
  const { navigation } = useDockNavigation();
  const { pendingTask, setPendingTask } = useIncomingTaskStore();
  const { pendingProject, setPendingProject } = useIncomingProjectStore();

  useEffect(() => {
    const params = inboundParams();
    if (params.get('action') !== 'open') return;
    const fmId = params.get('fm') || '';
    const convId = params.get('conversation_id') || '';
    const taskId = params.get('task_id') || '';
    const isGitSetup = params.get('setup_git') === '1';
    const projectId = params.get('project_id') || undefined;
    const projectError = params.get('project_error');
    const title = params.get('title') || 'Shared';
    const senderName = params.get('sender_name') || 'Someone';
    const gitOriginParam = params.get('git_origin');
    let gitOrigin: GitOrigin | null = null;
    if (gitOriginParam) {
      try {
        const parsed = JSON.parse(gitOriginParam) as GitOrigin;
        // A project's origin is its repo root (empty rel_path); the task branch
        // below still requires an asset position.
        gitOrigin = isInstallableOrigin(parsed) ? parsed : null;
      } catch {
        gitOrigin = null;
      }
    }

    // Scrub the whole payload so refreshing cannot re-trigger the action.
    consumeInboundParams(DEEP_LINK_PARAMS);

    // Git setup: "X shared a project with you" — clone the repo into a fresh,
    // indexed Project on THIS box. Checked before the task branch because a
    // git-setup link also carries a git_origin (but no task_id).
    if (isGitSetup && gitOrigin) {
      const pending = { gitOrigin, projectName: title, senderName, projectId };
      if (!projectId || !claimHydrateHop(projectId)) {
        setPendingProject(pending);
        return;
      }
      // Backward compatibility (FLOWPAD-2199; remove in FLOWPAD-2200): the hub's
      // email link sends a shared project this box may hold no row for. Route it
      // once through `project/<id>/open`, which mirrors the row from the hub and
      // redirects back here — with the same set-up, or a `project_error`.
      void Project.getById(projectId)
        .catch(() => null)
        .then((row) => {
          if (row) setPendingProject(pending);
          else window.location.assign(`/api/v1/graph/project/${encodeURIComponent(projectId)}/open`);
        });
      return;
    }

    // A shared project the desktop's `project/<id>/open` already resolved: it
    // either failed on the hub (say which — a refusal is final, an outage is
    // worth retrying) or is installed here, in which case there is nothing to
    // set up and the link just opens it. The failure notice is the only answer
    // to the link the person just clicked, so it shows in every view mode
    // (`forceToast`) and stays open until they dismiss it.
    if (projectId && projectError === 'unavailable') {
      notify.error({
        title: t`Couldn't open the project`,
        message: t`That project is no longer available.`,
        forceToast: true,
      });
      return;
    }
    if (projectId && projectError) {
      notify.warning({
        title: t`Couldn't open the project`,
        message: t`Couldn't reach FlowPad to load this project. Open the link again to retry.`,
        forceToast: true,
        durationMs: null,
      });
      return;
    }
    if (projectId && !isGitSetup) {
      navigation.openDock(withHomePage(DockPointer.forProject(projectId)));
      return;
    }

    if (gitOrigin && taskId && isCompleteGitOrigin(gitOrigin)) {
      setPendingTask({ taskId, taskTitle: title, senderName, gitOrigin });
      return;
    }

    if (convId) {
      navigation.openDock(DockPointer.forConversation(convId));
      return;
    }

    // Last resort: no convId in the deep link. If we have a taskId, open the
    // tasks dock; otherwise stay put. `fmId` is unused here but kept in the URL
    // params for diagnostics / future fallback.
    void fmId;
    if (taskId) {
      navigation.openDock(DockPointer.fromUrl('tasks', taskId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {/* Incoming task dialog — pull/clone flow for shared tasks */}
      {pendingTask && (
        <IncomingTaskDialog
          open={!!pendingTask}
          taskId={pendingTask.taskId}
          taskTitle={pendingTask.taskTitle}
          senderName={pendingTask.senderName}
          gitOrigin={pendingTask.gitOrigin}
          onClose={() => setPendingTask(null)}
        />
      )}

      {/* Incoming project dialog — clone a shared/linked repo into a Project */}
      {pendingProject && (
        <IncomingProjectDialog
          open={!!pendingProject}
          gitOrigin={pendingProject.gitOrigin}
          projectName={pendingProject.projectName}
          senderName={pendingProject.senderName}
          projectId={pendingProject.projectId}
          onClose={() => setPendingProject(null)}
        />
      )}
    </>
  );
}

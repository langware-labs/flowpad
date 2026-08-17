import { isCompleteGitOrigin, type GitOrigin } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { consumeInboundParams, inboundParams } from '@src/navigation/inbound-link';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
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
 * that repo into a fresh, indexed Project; `git_origin` + `task_id` → the task
 * pull/clone flow; `conversation_id` → open that conversation; `task_id` alone
 * → the tasks dock.
 */
/** The whole inbound payload — read together, scrubbed together, so no key can
 *  be left behind to replay on the next refresh. */
const DEEP_LINK_PARAMS = [
  'action',
  'fm',
  'conversation_id',
  'task_id',
  'setup_git',
  'title',
  'sender_name',
  'git_origin',
] as const;

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
    const title = params.get('title') || 'Shared';
    const senderName = params.get('sender_name') || 'Someone';
    const gitOriginParam = params.get('git_origin');
    let gitOrigin: GitOrigin | null = null;
    if (gitOriginParam) {
      try {
        const parsed = JSON.parse(gitOriginParam) as GitOrigin;
        gitOrigin = isCompleteGitOrigin(parsed) ? parsed : null;
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
      setPendingProject({ gitOrigin, projectName: title, senderName });
      return;
    }

    if (gitOrigin && taskId) {
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
          onClose={() => setPendingProject(null)}
        />
      )}
    </>
  );
}

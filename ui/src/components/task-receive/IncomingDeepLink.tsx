import { isCompleteGitOrigin, Project } from '@sdk';
import { isGitOrigin, type ProjectOrigin, projectOriginOf } from '@sdk/models/FSOrigin';
import { t } from '@lingui/core/macro';
import { useAuth } from '@sdk/react/hooks';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { DockPointer } from '@src/navigation/DockPointer';
import { consumeInboundParams, DeepLinkAction, inboundParams } from '@src/navigation/inbound-link';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications/notify';
import { withHomePage } from '@src/project-home-page/home-page-state';
import { type IncomingProjectParams, useIncomingProjectStore } from '@src/store/use-incoming-project-store';
import { useIncomingTaskStore } from '@src/store/use-incoming-task-store';
import { useEffect, useRef, useState } from 'react';
import { IncomingProjectDialog } from './IncomingProjectDialog';
import { IncomingTaskDialog } from './IncomingTaskDialog';
import { LaunchDialog } from './LaunchDialog';
import { LAUNCH_ACTION, LAUNCH_PARAMS, type LaunchPlan, launchPlanFromParams } from '@src/pages/entry/launch-plan';

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

/**
 * A project shared while this desktop had no FlowPad (or was signed out) reaches
 * no push and no deep link — installing FlowPad from the invite opens it on its
 * home. So once a session is signed in, ask the backend for the hub projects it
 * has never seen (in the background: nothing at startup waits on the hub) and
 * offer each one's set-up, one dialog at a time. A project already offered this
 * session — by a deep link too — is not offered again.
 */
function useOfferNewCloudProjects() {
  const { cloudUser } = useAuth();
  const { pendingProject, setPendingProject } = useIncomingProjectStore();
  const [queue, setQueue] = useState<IncomingProjectParams[]>([]);
  const sweptFor = useRef<string | null>(null);
  const offered = useRef(new Set<string>());

  const userId = cloudUser?.id ?? null;
  useEffect(() => {
    if (!userId || isHubOnly() || sweptFor.current === userId) return;
    sweptFor.current = userId;
    void Project.newFromHub()
      .then((links) => {
        const found: IncomingProjectParams[] = [];
        for (const link of links) {
          let gitOrigin: ProjectOrigin | null = null;
          try {
            gitOrigin = projectOriginOf({ git_origin: JSON.parse(link.git_origin) });
          } catch {
            gitOrigin = null;
          }
          if (!gitOrigin) continue;
          found.push({
            gitOrigin,
            projectName: link.title || 'Shared',
            senderName: 'Someone',
            projectId: link.project_id,
          });
        }
        if (found.length) setQueue((q) => [...q, ...found]);
      })
      .catch(() => {
        /* the hub is unreachable — the next sign-in or start asks again */
      });
  }, [userId]);

  useEffect(() => {
    if (pendingProject) {
      if (pendingProject.projectId) offered.current.add(pendingProject.projectId);
      return;
    }
    if (!queue.length) return;
    const rest = queue.filter((p) => !p.projectId || !offered.current.has(p.projectId));
    setQueue(rest.slice(1));
    if (rest.length) setPendingProject(rest[0]);
  }, [pendingProject, queue, setPendingProject]);
}

export function IncomingDeepLink() {
  const { navigation } = useDockNavigation();
  const { pendingTask, setPendingTask } = useIncomingTaskStore();
  const { pendingProject, setPendingProject } = useIncomingProjectStore();
  const [launchPlan, setLaunchPlan] = useState<LaunchPlan | null>(null);
  useOfferNewCloudProjects();

  useEffect(() => {
    const params = inboundParams();
    // A launch link (`/launch` on the hub → this machine): its SETUP stage, one handler for
    // the desktop and a cloud box alike. A malformed one is scrubbed and dropped.
    if (params.get('action') === LAUNCH_ACTION) {
      const plan = launchPlanFromParams(params);
      consumeInboundParams(LAUNCH_PARAMS);
      if (plan) setLaunchPlan(plan);
      else notify.error({ title: t`Couldn't launch`, message: t`That launch link is incomplete.`, forceToast: true });
      return;
    }
    if (params.get('action') !== DeepLinkAction.OPEN) return;
    const fmId = params.get('fm') || '';
    const convId = params.get('conversation_id') || '';
    const taskId = params.get('task_id') || '';
    const isGitSetup = params.get('setup_git') === '1';
    const projectId = params.get('project_id') || undefined;
    const projectError = params.get('project_error');
    const title = params.get('title') || 'Shared';
    const senderName = params.get('sender_name') || 'Someone';
    const gitOriginParam = params.get('git_origin');
    let gitOrigin: ProjectOrigin | null = null;
    if (gitOriginParam) {
      try {
        // A project's origin is its repo root (empty rel_path) or its hub-hosted
        // copy; the task branch below still requires a git asset position.
        gitOrigin = projectOriginOf({ git_origin: JSON.parse(gitOriginParam) });
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
      if (projectId && claimHydrateHop(projectId)) {
        // Backward compatibility (FLOWPAD-2199; remove in FLOWPAD-2200): the hub's
        // email link may name a project this box holds no row for. With no row,
        // hop through `project/<id>/open`, which mirrors it from the hub and
        // redirects back here — with the same set-up, or a `project_error`.
        void Project.getById(projectId)
          .catch(() => null)
          .then((row) =>
            row
              ? setPendingProject(pending)
              : window.location.assign(`/api/v1/graph/project/${encodeURIComponent(projectId)}/open`),
          );
      } else {
        setPendingProject(pending);
      }
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

    if (gitOrigin && taskId && isGitOrigin(gitOrigin) && isCompleteGitOrigin(gitOrigin)) {
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
      {launchPlan && <LaunchDialog plan={launchPlan} onClose={() => setLaunchPlan(null)} />}

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

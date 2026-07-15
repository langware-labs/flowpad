import { cloudManager, connectionManager, dataContext } from '@sdk';
import { ViewType } from '@src/types/ViewType';
import type { NotificationAction } from './types';
import { notify } from './notify';

/**
 * Maps backend WS signals into `notify()` calls — the single ingest point.
 *
 * Hub-error toast storms are fixed here: every hub error of a given status
 * class uses ONE stable id, so N broadcasts collapse to one live toast that
 * updates in place (was one sonner toast per event). 401s never toast at all —
 * logged-out is a normal state (login CTA overlay) and an expired/revoked
 * credential is only console/backend-logged.
 *
 * Owns: the `hub_client_error` listener, the one-shot bootstrap notice, and the
 * `on_flow_data` hook_op listener (skill / incoming-task badges) that used to
 * live in `use-notification-store.ts`.
 */

// --- hub client errors -------------------------------------------------------

interface HubClientErrorMsg {
  method?: string;
  path?: string;
  status_code?: number;
  message?: string;
  suppressed_count?: number;
}

function handleHubClientError(msg: HubClientErrorMsg): void {
  const method = String(msg.method ?? '').trim();
  const path = String(msg.path ?? '').trim();
  const statusCode = Number(msg.status_code ?? 0);
  const rawMessage = String(msg.message ?? '');
  const suppressed = Number(msg.suppressed_count ?? 0);

  if (suppressed > 0) {
    notify.warning({
      id: 'cloud-errors-suppressed',
      title: 'Hub errors suppressed',
      message: `${suppressed} hub errors were suppressed in the current window.`,
    });
    return;
  }

  // Stash the raw transport detail behind a power-user action, not the headline.
  const detail: NotificationAction = {
    label: 'Detail',
    command: 'debug.logHubError',
    args: { method, path, statusCode, message: rawMessage },
  };

  if (statusCode === 0) {
    notify.error({
      id: 'cloud-unreachable',
      title: 'Cloud is not available',
      message: "We couldn't reach the cloud service. Check your connection or try again in a moment.",
      actions: [detail],
    });
  } else if (statusCode === 401) {
    // A 401 while we were never authenticated (or after an explicit logout) is
    // the *normal* logged-out state — not an error. The inbox/conversation
    // surfaces show a Login CTA overlay for that case, so stay silent.
    if (cloudManager.loginStatus !== 'logged_in') return;
    // A 401 while we still believe we're logged in means the hub expired or
    // revoked the stored credential. No toast: the backend WARNs on every hub
    // 401 and the cloud surfaces show the login CTA, so a toast just nags on
    // every WS re-watch retry. Leave a console trail for diagnosis instead.
    console.warn(
      `[cloud] hub rejected ${method} ${path} with 401 while logged in — sign-in expired/revoked`,
      rawMessage,
    );
  } else if (statusCode === 403) {
    notify.error({
      id: 'cloud-access-denied',
      title: 'Cloud access denied',
      message: "You don't have permission for this action. Contact your admin if this seems wrong.",
      actions: [detail],
    });
  } else if (statusCode === 404) {
    notify.warning({
      id: 'cloud-not-found',
      title: 'Cloud resource not found',
      message: "We couldn't find what you were looking for on the cloud.",
      actions: [detail],
    });
  } else if (statusCode >= 500) {
    notify.error({
      id: 'cloud-server-error',
      title: 'Cloud service is having trouble',
      message: 'The cloud service returned an error. Please try again in a moment.',
      actions: [detail],
    });
  } else if (statusCode >= 400) {
    // Benign rejection: inviting someone who already accepted means the desired
    // state (they're a member) already holds, and the invite dialog surfaces its
    // own contextual error — the generic toast on top is pure noise.
    if (/already accepted/i.test(rawMessage)) {
      console.warn(`[cloud] hub rejected ${method} ${path} (${statusCode}) — benign: ${rawMessage}`);
      return;
    }
    notify.error({
      id: 'cloud-request-rejected',
      title: 'Cloud request rejected',
      message: rawMessage || `The cloud rejected the request (${statusCode}).`,
      actions: [detail],
    });
  }
}

// --- bootstrap notice (one-shot) ---------------------------------------------

let bootstrapNoticeShown = false;
function flushBootstrapNotice(): void {
  if (bootstrapNoticeShown) return;
  const notice = dataContext.bootstrapInfo?.notice;
  if (!notice) return;
  bootstrapNoticeShown = true;
  notify({
    id: notice.id,
    level: notice.level,
    title: notice.title,
    message: notice.message,
    durationMs: 12000,
  });
}

// --- skill / incoming-task badges (hook_op flow data) ------------------------

const HOOK_OP = 'hook_op';

async function handleFlowData(_typeId: unknown, flowData: Record<string, unknown>): Promise<void> {
  const attributes = flowData.attributes as Record<string, string> | undefined;
  if (attributes?.webhook_type !== HOOK_OP) return;

  const flowValue = flowData.flow_value as Record<string, unknown> | undefined;
  const rsType = flowValue?.type as string | undefined;
  const rsOp = flowValue?.operation as string | undefined;
  const rsData = flowValue?.data as Record<string, unknown> | undefined;
  const eventName = rsData?.event_name as string | undefined;
  const eventData = rsData?.event_data as Record<string, unknown> | undefined;
  const context = eventData?.context as { skill_name?: string; session_id?: string; cwd?: string } | undefined;

  if (rsType === 'skill' && rsOp === 'event' && eventName) {
    if (eventName === 'skill_activated') {
      const meta = (eventData?.notification ?? {}) as { skill_name?: string };
      if (meta.skill_name) {
        notify({
          id: `skill-activated:${meta.skill_name}`,
          level: 'info',
          title: meta.skill_name,
          category: ViewType.EXECUTE_FLOW,
          actions: [{ label: 'View', href: `/dock/${ViewType.EXECUTE_FLOW}` }],
        });
      }
    } else if (eventName === 'started_generating_skill' && context?.skill_name) {
      // Keyed on session so `skill_ready` upgrades this badge in place.
      notify({
        id: `skill:${context.session_id ?? context.skill_name}`,
        level: 'info',
        busy: true,
        title: `Generating: ${context.skill_name}`,
        category: ViewType.ASSETS,
        actions: context.session_id
          ? [
              {
                label: 'View Session',
                command: 'terminal.resume',
                args: { sessionId: context.session_id, ...(context.cwd ? { cwd: context.cwd } : {}) },
              },
            ]
          : undefined,
      });
    } else if (eventName === 'skill_ready' && context?.skill_name) {
      notify({
        id: `skill:${context.session_id ?? context.skill_name}`,
        level: 'success',
        title: `Ready: ${context.skill_name}`,
        category: ViewType.EXECUTE_FLOW,
        actions: context.cwd
          ? [{ label: 'Execute Skill', href: `/dock/${ViewType.EXECUTE_FLOW}/${encodeURIComponent(context.cwd)}` }]
          : undefined,
      });
    }
  }

  if (rsType === 'notification' && rsOp === 'create') {
    const ev = (rsData?.event_data ?? {}) as Record<string, unknown>;
    const taskTypeId = ev.task_type_id as string | undefined;
    const specType = (ev.spec_type as string | undefined) ?? 'plan';
    const senderName = (ev.sender_name as string | undefined) ?? 'Someone';
    const taskId = ev.task_id as string | undefined;
    const taskTitle = `New ${specType} from ${senderName}`;

    notify({
      id: `incoming-task:${taskId ?? taskTitle}`,
      level: 'info',
      title: taskTitle,
      category: ViewType.TASKS,
      typeId: taskTypeId,
      actions: [
        { label: 'View', href: taskTypeId ? `/dock/${ViewType.TASKS}/${taskTypeId}` : `/dock/${ViewType.TASKS}` },
      ],
    });

    // Side-effect: open the incoming-task dialog (kept out of `notify`).
    if (taskId) {
      const { useIncomingTaskStore } = await import('@src/store/use-incoming-task-store');
      useIncomingTaskStore.getState().setPendingTask({ taskId, taskTitle, senderName });
    }
  }
}

// Event-bus adapter: the bus expects a void listener; fire-and-forget the
// async handler through one stable reference so off() can unsubscribe it.
function onFlowDataEvent(typeId: unknown, flowData: Record<string, unknown>): void {
  void handleFlowData(typeId, flowData);
}

/** Wire all WS-driven notifications. Call once at app start; returns a cleanup fn. */
export function initNotificationIngest(): () => void {
  flushBootstrapNotice();
  cloudManager.on('hub_client_error', handleHubClientError);
  connectionManager.on('on_flow_data', onFlowDataEvent);

  // Dev-only test bridge: lets browser automation drive the real ingest path
  // (hub errors, hook_op flow data) and the dispatcher directly. Stripped from
  // production builds.
  if (import.meta.env?.DEV) {
    (window as unknown as Record<string, unknown>).__notifyTest = {
      notify,
      dismiss: notify.dismiss,
      hubError: (msg: HubClientErrorMsg) => handleHubClientError(msg),
      flowData: (flowData: Record<string, unknown>) => handleFlowData(undefined, flowData),
    };
  }

  return () => {
    cloudManager.off('hub_client_error', handleHubClientError);
    connectionManager.off('on_flow_data', onFlowDataEvent);
  };
}

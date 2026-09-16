import { t } from '@lingui/core/macro';
import { AgenticProcess, tabManager, TypeId } from '@sdk';
import { notify } from '@src/notifications';
import type { NavigationActions } from './NavigationActions';

/** The two related ids the name resolver reads off an AgenticProcess. */
type APWithIds = AgenticProcess & {
  session_id?: string | null;
  shell_id?: string | null;
  visible?: boolean;
};

const apFromCache = (processId: string) =>
  AgenticProcess.getByIdFromCache<AgenticProcess>(processId) as APWithIds | null;

/**
 * Read the backend-resolved process name from cache. Warm it with
 * {@link resolveAgenticProcessName} if necessary. Provider sessions and transport
 * shells do not supply independent UI naming policy.
 */
export function agenticProcessName(processId: string): string | null {
  return apFromCache(processId)?.name?.trim() || null;
}

/** Warm only the canonical process entity. */
export async function resolveAgenticProcessName(processId: string): Promise<void> {
  if (!apFromCache(processId)) await AgenticProcess.getById<AgenticProcess>(processId);
}

/**
 * Open an agentic process the way the footer's process list does: an Interactive
 * (visible PTY) worker attaches its live terminal; a headless worker opens the
 * read-only transcript lens to *view* the run rather than forcing a PTY.
 *
 * Pass `interactive` when the caller already knows the execution mode (the
 * footer derives it from `ExecutionMode.Interactive`); otherwise it's read from
 * the process's `visible` flag.
 */
export async function openAgenticProcess(
  processId: string,
  navigation: NavigationActions,
  interactive?: boolean,
): Promise<void> {
  try {
    // Resolve the backing entity only when we actually need it. An EXPLICIT
    // terminal intent (`interactive === true`) attaches the PTY by id alone and
    // must not depend on first reading the AgenticProcess: the entity may be
    // uncached and the fetch can fail (offline/transient), which would otherwise
    // swallow the click in the catch below and never open the terminal. The
    // entity is needed only to INFER `visible` (unspecified intent) or to read
    // `session_id` for the headless transcript branch.
    const cached = apFromCache(processId);
    const ap =
      interactive === true
        ? cached
        : (cached ?? ((await AgenticProcess.getById<AgenticProcess>(processId)) as APWithIds | null));
    const asTerminal = interactive ?? !!ap?.visible;

    if (asTerminal) {
      // Pin the explicit intent BEFORE navigating: the agent may live in another
      // project, so the navigation triggers a strip rebuild. Without this, the
      // self-heal resolver would re-pick the new project's default tab instead of
      // the clicked agent. resolveActive honors this intent, then consumes it once
      // the agent lands in the strip.
      tabManager.setPendingIntent(new TypeId(AgenticProcess.type, processId).toString());
      const opened = await navigation.openShellProcess(processId);
      if (!opened) {
        notify.error({
          title: t`Process unavailable`,
          message: t`That agent is no longer in your workspace.`,
        });
      }
      return;
    }

    // Headless → view the run's transcript (read-only). The lens category is
    // the PROCESS's vendor, not a literal — see AgenticProcess.
    const sessionId = ap?.session_id;
    if (sessionId && ap) {
      navigation.openLens(ap.transcriptLensCategory, 'transcript', sessionId);
    } else {
      notify.error({ title: t`No transcript`, message: t`This worker has no session to view yet.` });
    }
  } catch (err) {
    console.error('[openAgenticProcess] open failed', err);
    notify.error({
      title: t`Process unavailable`,
      message: t`That agent is no longer in your workspace.`,
    });
  }
}

/** `agentic_process-<uuid>` → `<uuid>`; null for any other (or absent) typeId. */
export function processIdFromTypeId(typeId?: string): string | null {
  if (!typeId) return null;
  const prefix = `${AgenticProcess.type}${TypeId.DELIMITER}`;
  return typeId.startsWith(prefix) ? typeId.slice(prefix.length) : null;
}

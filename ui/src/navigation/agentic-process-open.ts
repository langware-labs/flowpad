import { t } from '@lingui/core/macro';
import { AgenticProcess, ClaudeSession, Shell, tabManager, TypeId } from '@sdk';
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
 * Cached ClaudeSession lookup, guarded against the TypeId throw a non-v4/v5
 * worker session id triggers: ``getByIdFromCache`` builds a ``claude_session``
 * TypeId, which throws on codex/copilot v7 rollout ids (a worker session id
 * isn't a claude entity id). Returns null instead of crashing the caller.
 */
const cachedClaudeSession = (sessionId: string): ClaudeSession | null => {
  try {
    return ClaudeSession.getByIdFromCache<ClaudeSession>(sessionId) ?? null;
  } catch {
    return null;
  }
};

/**
 * Warm the ClaudeSession into cache if absent; null when already cached OR when
 * the id isn't a claude session id. ``getById`` also builds the throwing
 * ``claude_session`` TypeId, so the guard must wrap it too (not just the cache
 * read) — a v7 worker id would otherwise crash the resolver synchronously.
 */
const warmClaudeSession = (sessionId: string): Promise<unknown> | null => {
  try {
    return ClaudeSession.getByIdFromCache<ClaudeSession>(sessionId)
      ? null
      : ClaudeSession.getById<ClaudeSession>(sessionId);
  } catch {
    return null;
  }
};

/**
 * A worker's meaningful one-liner: the session title (the ai-title the history
 * and transcript views show) carried on its ClaudeSession, falling back to the
 * linked Shell's label. Reads the entity cache only (not reactive) — warm it
 * first with {@link resolveAgenticProcessName} when the caller can't guarantee
 * the process/session/shell are already loaded. Returns null when unresolved so
 * callers can fall back to an id fragment.
 */
export function agenticProcessName(processId: string): string | null {
  const ap = apFromCache(processId);
  // The AgenticProcess's OWN name wins first: it carries a user rename (footer /
  // tab) and the backend `stamp_default_name` default, so a rename shows here
  // immediately. Skip the `<type>-<id>` synthetic (`hasSyntheticDisplayName`) —
  // that is the "no real name" sentinel, not a title.
  const apName = ap && !ap.hasSyntheticDisplayName ? ap.name?.trim() : null;
  if (apName) return apName;
  const sessionId = ap?.session_id;
  // Best-effort title from the session entity (null for non-claude workers,
  // whose v7 session ids aren't claude entity ids — see cachedClaudeSession).
  const sessionName = sessionId ? cachedClaudeSession(sessionId)?.name : null;
  // ClaudeSession.name is `custom_title || slug || session_id`; only use it
  // when it's an actual title, not the raw id.
  if (sessionName && sessionName !== sessionId) return sessionName;
  const shellId = ap?.shell_id;
  return (shellId ? Shell.getByIdFromCache<Shell>(shellId)?.name : null) ?? null;
}

/** Warm the cache so {@link agenticProcessName} resolves: process → session / shell. */
export async function resolveAgenticProcessName(processId: string): Promise<void> {
  const ap = apFromCache(processId) ?? ((await AgenticProcess.getById<AgenticProcess>(processId)) as APWithIds | null);
  const sessionId = ap?.session_id;
  const shellId = ap?.shell_id;
  const sessionWarm = sessionId ? warmClaudeSession(sessionId) : null;
  await Promise.allSettled(
    [sessionWarm, shellId && !Shell.getByIdFromCache<Shell>(shellId) ? Shell.getById<Shell>(shellId) : null].filter(
      Boolean,
    ) as Promise<unknown>[],
  );
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

    // Headless → view the run's transcript (read-only).
    const sessionId = ap?.session_id;
    if (sessionId) {
      navigation.openLens('claude', 'transcript', sessionId);
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

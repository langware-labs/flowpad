/**
 * AgenticProcess loading primitive.
 *
 * Pure (no redirects, no toasts, no URL knowledge): fetches the process,
 * starts it to attach the PTY, resolves the linked Shell, and sets the
 * dataContext bits every caller needs. Failures throw typed errors — the
 * route wrapper decides how to recover (redirect URL, recovery skips, etc).
 */

import {
  AgenticProcess,
  ContextEntitiesEnum,
  dataContext,
  Shell,
  systemTools,
  TypeId,
} from '@sdk';
import { estimateCols, estimateRows } from '@src/components/terminal/interactive-terminal/terminalConfig';
import { ensureTerminalsFetched } from '@src/hooks/useActiveTerminals';
import { bumpLastActive } from '@src/tabs/last-active';
import { perfLog, perfTime } from './_perf';
import { loadProject } from './load-project';

/**
 * Two-tier error classification — ``severity`` decides route control flow,
 * ``kind`` carries diagnostics for the banner / toast.
 *
 *   * ``hard``  — the entity is unloadable at this URL. The route should
 *                 fall back to ``loadNextProcess`` and ``replace()`` the URL
 *                 to a sibling. Use only when the URL itself is dead.
 *   * ``soft``  — the entity exists; only the runtime is broken (PTY died,
 *                 shell record missing, project dangling, etc.). The route
 *                 must NOT redirect — it should render the page so the user
 *                 sees a banner with the matching recovery action on the URL
 *                 they actually requested. This is what prevents the
 *                 silent-redirect-after-backend-restart class of bugs.
 *
 * Previously every failure was treated as ``hard`` (single ``not_found`` /
 * ``start_failed`` / ``no_shell`` / ``project_missing`` enum without
 * severity). The route caught all of them uniformly and redirected. After
 * a backend restart that killed PTYs but kept entities alive, every URL
 * silently jumped to a stale cached sibling.
 */
export type ProcessLoadErrorKind =
  | 'entity_not_found'      // hard — entity row is gone
  | 'network_error'         // hard — fetch failed (non-404). URL still valid; show Retry.
  | 'runtime_terminated'    // soft — backend ``open`` returned null (process stopped/orphan)
  | 'shell_entity_missing'  // soft — start succeeded but Shell entity can't be resolved
  | 'pty_attach_failed'     // soft — PTY couldn't attach (compute node, mismatched pty_id, …)
  | 'project_missing'       // soft — process.project_id points at a deleted Project
  | 'failed_to_start';      // soft — worker exits instantly; backend latched, auto-relaunch paused

export type ProcessLoadErrorSeverity = 'hard' | 'soft';

const HARD_KINDS: ReadonlySet<ProcessLoadErrorKind> = new Set([
  'entity_not_found',
  'network_error',
]);

export class ProcessLoadError extends Error {
  readonly severity: ProcessLoadErrorSeverity;
  constructor(
    readonly kind: ProcessLoadErrorKind,
    readonly processId: string,
    readonly shellId?: string | null,
    readonly cause?: unknown,
  ) {
    super(`process-load:${kind}`);
    this.severity = HARD_KINDS.has(kind) ? 'hard' : 'soft';
  }
}

/**
 * Map an exception thrown inside the runtime phase (``process.start`` /
 * ``process.shell``) to the right ``soft`` kind. Pattern-matches on the
 * server-supplied error messages — those are the only signals available
 * without rewiring the SDK to throw typed errors of its own.
 */
function classifyRuntimeFailure(
  processId: string,
  process: AgenticProcess,
  cause: unknown,
): ProcessLoadError {
  // ApiFailResponse bodies surface through axios as a generic "Request
  // failed with status code 500" Error.message — the server's actual
  // message lives in response.data.message. Prefer it when present.
  const responseMsg = (cause as { response?: { data?: { message?: string } } })?.response?.data
    ?.message;
  const msg = responseMsg ?? (cause instanceof Error ? cause.message : String(cause ?? ''));
  if (/failed to start/i.test(msg)) {
    // Backend `open` refused: the worker exited instantly on its last
    // launch and the process is latched (`start_failure`). Auto-relaunch
    // is paused — only the banner's explicit Retry (start({retry:true}))
    // clears it.
    return new ProcessLoadError('failed_to_start', processId, process.shell_id ?? null, cause);
  }
  if (/process may be terminated/i.test(msg)) {
    return new ProcessLoadError('runtime_terminated', processId, process.shell_id ?? null, cause);
  }
  if (/Shell\s+\S+\s+not found after start/i.test(msg)) {
    return new ProcessLoadError('shell_entity_missing', processId, process.shell_id ?? null, cause);
  }
  // Default: anything else thrown inside start/shell/attachPty is a PTY
  // attachment failure — the most common case after a backend restart
  // (entity exists, PTY child is dead).
  return new ProcessLoadError('pty_attach_failed', processId, process.shell_id ?? null, cause);
}

export function describeProcessStartError(error: unknown): { title: string; description: string } {
  const rawMessage = error instanceof Error ? error.message : String(error ?? '').trim();
  if (/PTY .* not found/i.test(rawMessage)) {
    return { title: 'Terminal reattach failed', description: rawMessage };
  }
  if (/compute[_ -]?node/i.test(rawMessage) && /not found|missing|stale/i.test(rawMessage)) {
    return {
      title: 'Session unavailable',
      description: 'This session points to a stale compute node and could not be restored.',
    };
  }
  return {
    title: 'Session unavailable',
    description: rawMessage || 'Failed to restore this session.',
  };
}

/**
 * Load an AgenticProcess by id: cache-first fetch, `start({visible:true})` to
 * attach the PTY, resolve its Shell, write context. Idempotent when the
 * process is already live and attached in this client (fast path inside
 * AgenticProcess.start).
 *
 * Throws ProcessLoadError on any failure. Never redirects.
 */
export async function loadProcess(
  processId: string,
): Promise<{ process: AgenticProcess; shell: Shell }> {
  // ── Entity phase (hard errors only) ────────────────────────────────────
  // Split the fetch catch so a real network failure (timeout, abort,
  // non-404 5xx) reports as ``network_error`` instead of being silently
  // collapsed into ``entity_not_found``. The route uses both as hard
  // (URL is unloadable now) but distinguishes them so the banner can
  // offer Retry for transient hiccups vs. fall-through-to-sibling for
  // deleted entities.
  const cached = AgenticProcess.getByIdFromCache<AgenticProcess>(processId);
  perfLog(`loadProcess cache=${cached ? 'hit' : 'miss'} processId=${processId.slice(0, 8)}`);
  let process: AgenticProcess | null = cached ?? null;
  if (!process) {
    try {
      process = await perfTime('AgenticProcess.getById (network)', () =>
        AgenticProcess.getById<AgenticProcess>(processId),
      );
    } catch (cause) {
      // 404 → entity is genuinely gone; anything else → transient fetch
      // failure that doesn't mean the URL is dead.
      const status = (cause as { response?: { status?: number }; status?: number })?.response?.status
        ?? (cause as { status?: number })?.status;
      if (status === 404) {
        throw new ProcessLoadError('entity_not_found', processId, null, cause);
      }
      throw new ProcessLoadError('network_error', processId, null, cause);
    }
  }
  if (!process) {
    throw new ProcessLoadError('entity_not_found', processId);
  }

  // ── Project phase — URL-first: resolve the owning project into context
  // BEFORE any runtime side effect. `process.start()` and its downstream
  // (claude-session discovery, CWD selection for `claude --resume`, etc.)
  // read `dataContext.project`; if that still reflects the previously-active
  // project, the PTY launches in the wrong CWD and Claude can't find the
  // transcript. Doing the project write here makes every consumer URL-first.
  if (process.project_id) {
    try {
      await perfTime('loadProject', () => loadProject(process!.project_id!));
    } catch (cause) {
      // The stored project_id can dangle when the project was deleted under
      // us. Recover via the backend's 3-phase recover_by_path, then continue.
      const status = (cause as { response?: { status?: number }; status?: number })?.response?.status
        ?? (cause as { status?: number })?.status;
      if (status !== 404) throw cause;
      const recovered = await process.recoverProject().catch(() => null);
      if (!recovered) {
        throw new ProcessLoadError('project_missing', processId, process.shell_id ?? null, cause);
      }
      await loadProject(recovered.id);
    }
  } else {
    await systemTools.resolveProjectContext(process.workdir, process);
  }

  // ── Runtime phase (soft errors — entity is fine, runtime isn't) ────────
  let shell: Shell | null = null;
  try {
    const cols = estimateCols(window.innerWidth);
    const rows = estimateRows(window.innerHeight);
    await perfTime('process.start (PTY attach)', () =>
      process.start({ visible: true, cols, rows }),
    );
    shell = await perfTime('process.shell()', () => process.shell());
  } catch (cause) {
    throw classifyRuntimeFailure(processId, process, cause);
  }

  if (!shell) {
    throw new ProcessLoadError('shell_entity_missing', processId, process.shell_id ?? null);
  }

  // Populate the strip from the server (idempotent — no-op after the first
  // call in this session) so TabbedTerminal mounts with the full list, sorted
  // by server `tab_order`. The previous approach pushed a single optimistic
  // row before the fetch, which trapped that row at index 0 on hard refresh
  // (the merge's preserve-order branch keyed off `prev.length === 0`). Doing
  // the fetch here closes the self-heal race without seeding the order.
  await perfTime('ensureTerminalsFetched', () => ensureTerminalsFetched());

  await perfTime('dataContext sync setters (shellId/target/workdir)', async () => {
    dataContext.setActiveShellId(shell!.id);
    dataContext.setActiveTerminalTargetTypeId(new TypeId(AgenticProcess.type, processId));
    bumpLastActive(process); // recency seed on the process (tab identity) — Bug 1
    dataContext.setWorkdir(
      process!.workdir ?? shell!.workdir ?? dataContext.project?.fs_storage_mount_path ?? null,
    );
  });
  await perfTime('setContextEntityTypeId(CurrentProcessTypeId)', () =>
    dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProcessTypeId,
      new TypeId(AgenticProcess.type, processId),
    ),
  );

  return { process, shell };
}

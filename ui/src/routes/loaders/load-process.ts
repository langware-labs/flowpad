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
  Project,
  Shell,
  systemTools,
  TypeId,
} from '@sdk';
import { estimateCols, estimateRows } from '@src/components/terminal/interactive-terminal/terminalConfig';

/**
 * Route wrappers pattern-match on `kind` to decide recovery behavior.
 * Never bubble a raw error past a route boundary — translate to redirect.
 */
export class ProcessLoadError extends Error {
  constructor(
    readonly kind: 'not_found' | 'start_failed' | 'no_shell',
    readonly processId: string,
    readonly shellId?: string | null,
    readonly cause?: unknown,
  ) {
    super(`process-load:${kind}`);
  }
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
  const process =
    AgenticProcess.getByIdFromCache<AgenticProcess>(processId) ??
    (await AgenticProcess.getById<AgenticProcess>(processId).catch(() => null));
  if (!process) {
    throw new ProcessLoadError('not_found', processId);
  }

  let shell: Shell | null = null;
  try {
    // Seed the PTY with viewport-derived dimensions instead of the 80x24
    // VT100 default. The InteractiveTerminal issues an authoritative resize
    // after fit.fit(); this seed only needs to be in the right ballpark to
    // avoid the worker's first paint being wrapped at 80 cols on a wide
    // viewport. SSR-safe: window is always defined here (loader runs in the
    // browser via React Router).
    const cols = estimateCols(window.innerWidth);
    const rows = estimateRows(window.innerHeight);
    await process.start({ visible: true, cols, rows });
    shell = await process.shell();
  } catch (cause) {
    throw new ProcessLoadError('start_failed', processId, process.shell_id ?? null, cause);
  }

  if (!shell) {
    throw new ProcessLoadError('no_shell', processId, process.shell_id ?? null);
  }

  dataContext.setActiveShellId(shell.id);
  dataContext.setWorkdir(
    process.workdir ?? shell.workdir ?? dataContext.project?.fs_storage_mount_path ?? null,
  );
  await dataContext.setContextEntityTypeId(
    ContextEntitiesEnum.CurrentProcessTypeId,
    new TypeId(AgenticProcess.type, processId),
  );
  if (process.project_id) {
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      new TypeId(Project.type, process.project_id),
    );
  } else {
    await systemTools.resolveProjectContext(process.workdir, process);
  }

  return { process, shell };
}

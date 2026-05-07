/**
 * Shell dock loader for /dock/shell[/<pointer>].
 *
 * Two layers:
 *   - `loadShell(shellId)` — pure primitive. Attaches a plain Shell's PTY and
 *     writes dataContext. Throws typed errors. No redirects.
 *   - `loadShellRoute(pointer)` — route wrapper. Dispatches on pointer shape,
 *     delegates to `loadShell` / `loadProcess`. On any per-candidate failure,
 *     hands off to `loadNextProcess` to find the next-best tab.
 *
 * Dispatch shapes:
 *   - no pointer          → loadNextProcess() — pick & load the best candidate
 *   - "new_terminal"      → create a fresh Shell and redirect into it
 *   - agentic_process-*   → loadProcess(); on typed failure → loadNextProcess
 *   - shell-<uuid> / uuid → loadShell();   on typed failure → loadNextProcess
 *                           (unless a process owns it — redirect to process)
 *
 * Failure UI: 1 cleanup → toast; 2+ cleanups → modal counter.
 */

import {
  AgenticProcess,
  connectionManager,
  ContextEntitiesEnum,
  dataContext,
  dataManager,
  Project,
  QueryRequest,
  Shell,
  ShellStatus,
  systemTools,
  TypeId,
} from '@sdk';
import {
  closeTerminalTargets,
  terminalProcessId,
  terminalTransportShellId,
  type TerminalTab,
} from '@src/hooks/useActiveTerminals';
import { showCleanupModal } from '@src/components/recovery/cleanup-modal';
import { toast } from '@src/hooks/use-toast';
import { DockPointer } from '@src/navigation';
import { redirect, replace } from 'react-router';
import {
  describeProcessStartError,
  loadProcess,
  ProcessLoadError,
} from './load-process';
import {
  loadNextProcess,
  type CleanupRecord,
  type LoadedNext,
} from './load-next-process';

// ── typed error (for plain-Shell loads) ─────────────────────────────────────

export class ShellLoadError extends Error {
  constructor(
    readonly kind: 'not_found' | 'error_status' | 'start_failed',
    readonly shellId: string,
    readonly errorMessage?: string | null,
    readonly cause?: unknown,
  ) {
    super(`shell-load:${kind}`);
  }
}

// ── internal helpers ────────────────────────────────────────────────────────

// Synchronously iterate the DataManager entity cache, returning all live
// entities of a given type. Used to skip redundant backend queries on tab
// switches — the cache is kept warm by `useActiveTerminals`'s live subscription.
function cachedEntitiesByType<U>(type: string): U[] {
  const out: U[] = [];
  for (const [typeId, ref] of dataManager.entities.entries()) {
    if (typeId.type !== type) continue;
    const entity = ref.entity as unknown as U | undefined;
    if (entity) out.push(entity);
  }
  return out;
}

function _perfLog(label: string) {
  const t0 = (window as Record<string, unknown>).__shellNavT0 as number | undefined;
  if (t0 !== undefined) console.log(`[PERF] +${(performance.now() - t0).toFixed(0)}ms ${label}`);
}

// ── CORE: loadShell(shellId) — pure, no redirects ───────────────────────────

/**
 * Load a plain Shell by id: cache-first fetch, attach PTY via `shell.start`,
 * write dataContext. Throws ShellLoadError. Never redirects. Does NOT check
 * for a linked AgenticProcess — the route wrapper is responsible for that
 * dispatch (and will call `loadProcess` instead when a process owns the shell).
 */
export async function loadShell(shellId: string): Promise<Shell> {
  const shell =
    Shell.getByIdFromCache<Shell>(shellId) ??
    (await Shell.getById<Shell>(shellId).catch(() => null));
  if (!shell) {
    throw new ShellLoadError('not_found', shellId);
  }
  if (shell.status === ShellStatus.ERROR) {
    throw new ShellLoadError('error_status', shellId, shell.error_message ?? null);
  }
  try {
    await shell.start({ cols: Shell.DEFAULT_COLS, rows: Shell.DEFAULT_ROWS, workdir: shell.workdir ?? undefined });
  } catch (cause) {
    throw new ShellLoadError('start_failed', shellId, null, cause);
  }

  dataContext.setActiveShellId(shell.id);
  dataContext.setActiveTerminalTargetTypeId(shell.typeId);
  dataContext.setWorkdir(shell.workdir ?? dataContext.project?.fs_storage_mount_path ?? null);
  await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, null);
  if (shell.project_id) {
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      new TypeId(Project.type, shell.project_id),
    );
  } else {
    await systemTools.resolveProjectContext(shell.workdir ?? undefined, shell);
  }
  return shell;
}

// ── default-tab resolution (exported for unit tests + loadNextProcess) ─────

/**
 * Pick a default tab from a pre-filtered list. Prefers the previously-active
 * target, then falls back to the first non-disabled tab. Skips any tab whose
 * target TypeId, target id, transport shell id, or owning-process id is in
 * `excludeIds`. Returns null when nothing is pickable.
 *
 * `excludeIds` is a single set because process ids and shell ids are both
 * UUIDs and don't collide.
 */
export function resolveDefaultTab(
  tabs: TerminalTab[],
  excludeIds: Set<string> = new Set(),
): TerminalTab | null {
  const isPickable = (tab: TerminalTab) => {
    if (tab.isDisabled) return false;
    if (excludeIds.has(tab.targetTypeId.toString())) return false;
    if (excludeIds.has(tab.targetTypeId.id)) return false;
    const shellId = terminalTransportShellId(tab);
    if (shellId && excludeIds.has(shellId)) return false;
    const processId = terminalProcessId(tab);
    if (processId && excludeIds.has(processId)) return false;
    return true;
  };

  const previousTargetTypeId = dataContext.activeTerminalTargetTypeId;
  if (previousTargetTypeId) {
    const previous = tabs.find((t) => t.targetTypeId.equals(previousTargetTypeId) && isPickable(t));
    if (previous) return previous;
  }
  const previousShellId = dataContext.activeShellId;
  if (previousShellId) {
    const previous = tabs.find(
      (t) => t.targetTypeId.type === Shell.type && t.targetTypeId.id === previousShellId && isPickable(t),
    );
    if (previous) return previous;
  }
  return tabs.find(isPickable) ?? null;
}

// ── cleanup UI dispatch ─────────────────────────────────────────────────────

/**
 * Render the cleanup outcome to the user. Single cleanup → toast. Two or more
 * → counter modal. Empty → no UI.
 */
function handleCleanups(cleaned: CleanupRecord[]): void {
  if (cleaned.length === 0) return;
  if (cleaned.length === 1) {
    const c = cleaned[0];
    toast({ title: c.title, description: c.description, variant: 'destructive' });
    return;
  }
  showCleanupModal({ count: cleaned.length });
}

function loadedToPointer(loaded: LoadedNext): string {
  return loaded.kind === 'process'
    ? loaded.process.dockPointer.pointer
    : loaded.shell.dockPointer.pointer;
}

// ── ROUTE: internal branches ────────────────────────────────────────────────

async function routeNewTerminal(): Promise<never> {
  const cn = dataContext.computeNode;
  if (!cn) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw replace('/dock/shell');
  }
  const shells = await Shell.query<Shell>(new QueryRequest({ type: Shell.type, scope: [] }));
  const { nextTerminalName } = await import('@src/components/terminal/TabbedTerminal');
  const name = nextTerminalName(shells.map((s) => ({ name: s.name ?? '' })));
  const cwd = dataContext.project?.fs_storage_mount_path ?? undefined;
  const newShell = Shell.create(cn, { name, workdir: cwd });
  await newShell.save(cn.typeId);
  // Use replace so going BACK doesn't re-trigger this loader and create
  // another terminal.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw replace(`/dock/shell/${newShell.dockPointer.pointer}`);
}

async function routeDefaultShell(): Promise<void> {
  const result = await loadNextProcess({ projectId: dataContext.project?.id ?? null });
  handleCleanups(result.cleaned);
  if (!result.loaded) {
    // Empty state: clear context, render whatever the shell view shows when
    // nothing is selected.
    dataContext.setActiveShellId('');
    dataContext.setActiveTerminalTargetTypeId(null);
    dataContext.setWorkdir(dataContext.project?.fs_storage_mount_path ?? null);
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, null);
    return;
  }
  _perfLog(`routeDefaultShell redirect → /dock/shell/${loadedToPointer(result.loaded)}`);
  // Push (not replace): the user navigated *to* /dock/shell intentionally.
  // Replacing here would erase that navigation step from history, so BACK
  // would skip the user's previous page (home → terminal → BACK should
  // return to home, not whatever was before home).
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect(`/dock/shell/${loadedToPointer(result.loaded)}`);
}

async function routeProcessPointer(processId: string): Promise<void> {
  try {
    await loadProcess(processId);
    return;
  } catch (e) {
    if (!(e instanceof ProcessLoadError)) throw e;
    // The direct-link target is broken — synthesize a CleanupRecord for it
    // (so the UI counter includes it) and fall back to the next candidate.
    // Use replace so the broken URL doesn't sit in history; otherwise BACK
    // would pop right back to it and re-trigger this loader → flicker.
    const directCleanup = buildProcessCleanupForRoute(e);
    const next = await loadNextProcess({
      excludeIds: new Set([processId]),
      projectId: dataContext.project?.id ?? null,
    });
    handleCleanups([directCleanup, ...next.cleaned]);
    if (!next.loaded) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw replace('/dock/shell');
    }
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw replace(`/dock/shell/${loadedToPointer(next.loaded)}`);
  }
}

async function routePlainShellPointer(pointer: string): Promise<void> {
  const shellId = pointer.startsWith(Shell.type + '-')
    ? pointer.slice(Shell.type.length + 1)
    : pointer;

  // If a process owns this shell, send the user to the process URL instead —
  // that path handles open({ visible: true }) + PTY reconnect for us.
  const linkedProcess = cachedEntitiesByType<AgenticProcess>(AgenticProcess.type).find(
    (p) => p.shell_id === shellId,
  );
  if (linkedProcess) {
    // Use replace so BACK from the process URL doesn't pop back to the bare
    // shell URL (which would just re-bounce here → flicker).
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw replace(`/dock/shell/${linkedProcess.dockPointer.pointer}`);
  }

  try {
    await loadShell(shellId);
    return;
  } catch (e) {
    if (!(e instanceof ShellLoadError)) throw e;

    // Pointer wasn't a Shell id — try resolving it as a Claude/Codex worker
    // session id via the backend before falling back to "next process". This
    // is the URL-deep-link path: /dock/shell/<worker-session-uuid>.
    if (e.kind === 'not_found') {
      const recovered = await AgenticProcess.getByWorkerId(shellId).catch(() => null);
      if (recovered) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw replace(`/dock/shell/${recovered.dockPointer.pointer}`);
      }
    }

    // See routeProcessPointer for rationale on `replace`.
    const directCleanup = await buildShellCleanupForRoute(e);
    const next = await loadNextProcess({
      excludeIds: new Set([shellId]),
      projectId: dataContext.project?.id ?? null,
    });
    handleCleanups([directCleanup, ...next.cleaned]);
    if (!next.loaded) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw replace('/dock/shell');
    }
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw replace(`/dock/shell/${loadedToPointer(next.loaded)}`);
  }
}

// Lightweight versions of buildProcessCleanup / buildShellCleanup for direct-link
// failures that originated outside `loadNextProcess`. Phrasing matches.
function buildProcessCleanupForRoute(e: ProcessLoadError): CleanupRecord {
  switch (e.kind) {
    case 'not_found':
      return { kind: 'process_not_found', processId: e.processId, title: 'Session not found', description: 'Agentic process does not exist.' };
    case 'start_failed': {
      const desc = describeProcessStartError(e.cause ?? e);
      return { kind: 'process_start_failed', processId: e.processId, shellId: e.shellId ?? undefined, title: desc.title, description: desc.description };
    }
    case 'no_shell':
      return { kind: 'process_no_shell', processId: e.processId, shellId: e.shellId ?? undefined, title: 'Session unavailable', description: 'No shell is linked to this process.' };
    case 'project_missing':
      return { kind: 'process_project_missing', processId: e.processId, shellId: e.shellId ?? undefined, title: 'Project not found', description: 'Could not recover this session’s project.' };
  }
}

async function buildShellCleanupForRoute(e: ShellLoadError): Promise<CleanupRecord> {
  switch (e.kind) {
    case 'not_found':
      return { kind: 'shell_not_found', shellId: e.shellId, title: 'Shell not found', description: 'This terminal no longer exists.' };
    case 'error_status':
      return { kind: 'shell_error_status', shellId: e.shellId, title: 'Shell unavailable', description: e.errorMessage ?? 'Shell error' };
    case 'start_failed': {
      await closeTerminalTargets([new TypeId(Shell.type, e.shellId)]).catch(() => {});
      const desc = describeProcessStartError(e.cause ?? e);
      return { kind: 'shell_start_failed', shellId: e.shellId, title: desc.title, description: desc.description };
    }
  }
}

// ── ROUTE: public entry point ───────────────────────────────────────────────

/**
 * Route-level loader for /dock/shell. Registered from main-loader.ts.
 *
 * Owns the redirect policy for this URL namespace. Internals delegate to the
 * pure `loadShell` / `loadProcess` primitives, with `loadNextProcess` as the
 * single recovery / fallback primitive.
 */
export async function loadShellRoute(pointer: string | undefined): Promise<void> {
  _perfLog(`loadShellRoute(${pointer || 'no-pointer'}) start`);

  // Gate on the FlowSync WS being OPEN. The dispatch chain below
  // (loadProcess → process.start → shell.attachPty → _reattach → callActionOverWS)
  // throws synchronously when the socket isn't connected, which on cold tabs
  // races against initSdk's fire-and-forget connect. 5 s budget; on timeout we
  // surface a toast and fall through (the existing redirect-on-failure chain
  // still applies if the downstream WS call ultimately fails).
  try {
    await connectionManager.waitForConnected(5000);
  } catch {
    toast({
      title: 'No realtime connection',
      description: 'Terminal may be unresponsive until the connection recovers.',
      variant: 'destructive',
    });
  }

  if (pointer === 'new_terminal') {
    await routeNewTerminal();
  }

  if (!pointer) {
    await routeDefaultShell();
    return;
  }

  if (DockPointer.isAgenticProcessPointer(pointer)) {
    const processId = DockPointer.extractAgenticProcessId(pointer);
    await routeProcessPointer(processId);
    _perfLog('loadShellRoute done (agentic process path)');
    return;
  }

  await routePlainShellPointer(pointer);
  _perfLog('loadShellRoute done (shell path)');
}

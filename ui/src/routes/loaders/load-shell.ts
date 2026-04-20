/**
 * Shell dock loader for /dock/shell[/<pointer>].
 *
 * Two layers:
 *   - `loadShell(shellId)` — pure primitive. Attaches a plain Shell's PTY and
 *     writes dataContext. Throws typed errors. No redirects.
 *   - `loadShellRoute(pointer, recoverySkips)` — route wrapper. Dispatches on
 *     pointer shape, delegates to `loadShell` / `loadProcess`, catches typed
 *     errors and redirects to the appropriate `/dock/shell/...` recovery URL.
 *
 * Dispatch shapes (loadShellRoute):
 *   - no pointer          → pick a default shell (previously-active, then any alive)
 *   - "new_terminal"      → create a fresh Shell and redirect into it
 *   - agentic_process-*   → delegate to loadProcess()
 *   - shell-<uuid> / uuid → delegate to loadShell()
 *                           (unless a process owns it — redirect to the process URL)
 *
 * Every failure path redirects to /dock/shell with the offending ids encoded
 * in `skip_*` query params so the default resolver won't loop.
 */

import {
  AgenticProcess,
  ContextEntitiesEnum,
  dataContext,
  dataManager,
  isProcessActive,
  Project,
  QueryFilter,
  QueryRequest,
  Shell,
  ShellStatus,
  systemTools,
  TypeId,
} from '@sdk';
import { toast } from '@src/hooks/use-toast';
import { DockPointer } from '@src/navigation';
import { redirect } from 'react-router';
import { describeProcessStartError, loadProcess, ProcessLoadError } from './load-process';
import {
  appendRecoverySkip,
  buildShellRecoveryUrl,
  emptyRecoverySkips,
  type ShellRecoverySkips,
  withRecoverySearch,
} from './shell-recovery';

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

async function fetchShellsAndProcesses(): Promise<[Shell[], AgenticProcess[]]> {
  return Promise.all([
    Shell.query<Shell>(new QueryRequest({ type: Shell.type, scope: [] })),
    AgenticProcess.query<AgenticProcess>(
      new QueryRequest({
        type: AgenticProcess.type,
        scope: [],
        query: new QueryFilter({ match: { visible: true } as Record<string, unknown> }),
      }),
    ),
  ]);
}

function previousThenRemainingShells(shells: Shell[], isAlive: (shell: Shell) => boolean): Shell[] {
  const ordered: Shell[] = [];
  const previousShellId = dataContext.activeShellId;
  const previousShell = previousShellId ? shells.find((s) => s.id === previousShellId && isAlive(s)) : null;
  if (previousShell) ordered.push(previousShell);

  for (const shell of shells) {
    if (!isAlive(shell)) continue;
    if (ordered.some((candidate) => candidate.id === shell.id)) continue;
    ordered.push(shell);
  }
  return ordered;
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

// ── default-shell resolution (exported for unit tests) ──────────────────────

/**
 * Handle the no-pointer case: pick a target URL for the previously-active or
 * first alive shell. Returns null if no alive shell exists.
 */
export function resolveDefaultShell(
  shells: Shell[],
  processes: AgenticProcess[],
  recoverySkips: ShellRecoverySkips = emptyRecoverySkips(),
): string | null {
  const hiddenStatuses = new Set<string>([ShellStatus.CLOSED, ShellStatus.CLOSING, ShellStatus.ERROR]);
  const activeProcesses = processes.filter((p) => isProcessActive(p.status));
  const isAlive = (s: Shell) => !hiddenStatuses.has(s.status as ShellStatus);
  const { skipProcessIds, skipShellIds } = recoverySkips;

  const resolveUrl = (shell: Shell) => {
    const p = activeProcesses.find((ap) => ap.shell_id === shell.id);
    if (skipShellIds.has(shell.id) || (p?.id && skipProcessIds.has(p.id))) return null;
    const baseUrl = `/dock/shell/${(p ?? shell).dockPointer.pointer}`;
    return p ? withRecoverySearch(baseUrl, recoverySkips) : baseUrl;
  };

  for (const shell of previousThenRemainingShells(shells, isAlive)) {
    const url = resolveUrl(shell);
    if (url) return url;
  }
  return null;
}

// ── ROUTE: internal branches ────────────────────────────────────────────────

async function routeNewTerminal(): Promise<never> {
  const cn = dataContext.computeNode;
  if (!cn) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect('/dock/shell');
  }
  const shells = await Shell.query<Shell>(new QueryRequest({ type: Shell.type, scope: [] }));
  const { nextTerminalName } = await import('@src/components/terminal/TabbedTerminal');
  const name = nextTerminalName(shells.map((s) => ({ name: s.name ?? '' })));
  const cwd = dataContext.project?.fs_storage_mount_path ?? undefined;
  const newShell = Shell.create(cn, { name, workdir: cwd });
  await newShell.save(cn.typeId);
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect(`/dock/shell/${newShell.dockPointer.pointer}`);
}

async function routeDefaultShell(recoverySkips: ShellRecoverySkips): Promise<void> {
  // Needs the full visible-process set to pick a default shell.
  // Only happens on cold navigation to /dock/shell (not on tab clicks).
  const [shells, processes] = await fetchShellsAndProcesses();
  _perfLog(`loadShellRoute queries done (${shells.length} shells, ${processes.length} processes)`);

  const redirectUrl = resolveDefaultShell(shells, processes, recoverySkips);
  if (redirectUrl) {
    _perfLog(`loadShellRoute redirect → ${redirectUrl}`);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(redirectUrl);
  }
  dataContext.setActiveShellId('');
  dataContext.setWorkdir(dataContext.project?.fs_storage_mount_path ?? null);
  await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, null);
}

async function routeProcessPointer(processId: string, recoverySkips: ShellRecoverySkips): Promise<void> {
  try {
    await loadProcess(processId);
  } catch (e) {
    if (!(e instanceof ProcessLoadError)) throw e;
    if (e.kind === 'not_found') {
      toast({
        title: 'Session not found',
        description: 'Agentic process does not exist.',
        variant: 'destructive',
      });
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect('/dock/shell');
    }
    if (e.kind === 'start_failed') {
      toast({ ...describeProcessStartError(e.cause ?? e), variant: 'destructive' });
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(buildShellRecoveryUrl(appendRecoverySkip(recoverySkips, e.processId, e.shellId)));
    }
    // no_shell
    toast({
      title: 'Session unavailable',
      description: 'No shell is linked to this process.',
      variant: 'destructive',
    });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(buildShellRecoveryUrl(appendRecoverySkip(recoverySkips, e.processId, e.shellId)));
  }
}

async function routePlainShellPointer(pointer: string, recoverySkips: ShellRecoverySkips): Promise<void> {
  // Shell pointer: "shell-<uuid>" or bare UUID.
  const shellId = pointer.startsWith(Shell.type + '-') ? pointer.slice(Shell.type.length + 1) : pointer;

  // If a process owns this shell, send the user to the process URL instead —
  // that path handles open({ visible: true }) + PTY reconnect for us.
  const linkedProcess = cachedEntitiesByType<AgenticProcess>(AgenticProcess.type).find(
    (p) => p.shell_id === shellId,
  );
  if (linkedProcess) {
    if (recoverySkips.skipProcessIds.has(linkedProcess.id) || recoverySkips.skipShellIds.has(shellId)) {
      // Avoid bouncing straight back into the same failing process restore.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(buildShellRecoveryUrl(recoverySkips));
    }
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(withRecoverySearch(`/dock/shell/${linkedProcess.dockPointer.pointer}`, recoverySkips));
  }

  try {
    await loadShell(shellId);
  } catch (e) {
    if (!(e instanceof ShellLoadError)) throw e;
    if (e.kind === 'not_found') {
      toast({
        title: 'Shell not found',
        description: 'This terminal no longer exists.',
        variant: 'destructive',
      });
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect('/dock/shell');
    }
    if (e.kind === 'error_status') {
      toast({
        title: 'Shell unavailable',
        description: e.errorMessage ?? 'Shell error',
        variant: 'destructive',
      });
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect('/dock/shell');
    }
    // start_failed
    toast({ ...describeProcessStartError(e.cause ?? e), variant: 'destructive' });
    // Attempt a best-effort close so the user isn't stuck with a zombie row.
    const shell = Shell.getByIdFromCache<Shell>(e.shellId);
    await shell?.close().catch(() => {});
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(buildShellRecoveryUrl(appendRecoverySkip(recoverySkips, null, e.shellId)));
  }
}

// ── ROUTE: public entry point ───────────────────────────────────────────────

/**
 * Route-level loader for /dock/shell. Registered from main-loader.ts.
 *
 * Owns the redirect policy for this URL namespace. Internals delegate to the
 * pure `loadShell` / `loadProcess` primitives.
 */
export async function loadShellRoute(
  pointer: string | undefined,
  recoverySkips: ShellRecoverySkips = emptyRecoverySkips(),
): Promise<void> {
  _perfLog(`loadShellRoute(${pointer || 'no-pointer'}) start`);

  if (pointer === 'new_terminal') {
    await routeNewTerminal();
  }

  if (!pointer) {
    await routeDefaultShell(recoverySkips);
    return;
  }

  if (DockPointer.isAgenticProcessPointer(pointer)) {
    const processId = DockPointer.extractAgenticProcessId(pointer);
    await routeProcessPointer(processId, recoverySkips);
    _perfLog('loadShellRoute done (agentic process path)');
    return;
  }

  await routePlainShellPointer(pointer, recoverySkips);
  _perfLog('loadShellRoute done (shell path)');
}

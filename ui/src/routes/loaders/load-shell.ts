/**
 * Shell dock loader for /dock/shell[/<pointer>].
 *
 * Dispatches on the shape of `pointer`:
 *   - no pointer          → pick a default shell (previously-active, then any alive)
 *   - "new_terminal"      → create a fresh Shell and redirect into it
 *   - agentic_process-*   → delegate to load-process.ts
 *   - shell-<uuid> / uuid → plain Shell attach (or redirect to its linked process)
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
import { describeProcessStartError, loadAgenticProcessFromPointer } from './load-process';
import {
  appendRecoverySkip,
  buildShellRecoveryUrl,
  emptyRecoverySkips,
  type ShellRecoverySkips,
  withRecoverySearch,
} from './shell-recovery';

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

// ── branches of loadShell ───────────────────────────────────────────────────

async function loadNewTerminal(): Promise<never> {
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

async function loadDefaultShell(recoverySkips: ShellRecoverySkips): Promise<void> {
  // Needs the full visible-process set to pick a default shell.
  // Only happens on cold navigation to /dock/shell (not on tab clicks).
  const [shells, processes] = await fetchShellsAndProcesses();
  _perfLog(`loadShell queries done (${shells.length} shells, ${processes.length} processes)`);

  const redirectUrl = resolveDefaultShell(shells, processes, recoverySkips);
  if (redirectUrl) {
    _perfLog(`loadShell redirect → ${redirectUrl}`);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(redirectUrl);
  }
  dataContext.setActiveShellId('');
  dataContext.setWorkdir(dataContext.project?.fs_storage_mount_path ?? null);
  await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, null);
}

async function loadPlainShell(pointer: string, recoverySkips: ShellRecoverySkips): Promise<void> {
  // Shell pointer: "shell-<uuid>" or bare UUID.
  const shellId = pointer.startsWith(Shell.type + '-') ? pointer.slice(Shell.type.length + 1) : pointer;
  const shell = Shell.getByIdFromCache<Shell>(shellId) ?? (await Shell.getById<Shell>(shellId).catch(() => null));

  if (!shell) {
    toast({ title: 'Shell not found', description: 'This terminal no longer exists.', variant: 'destructive' });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect('/dock/shell');
  }

  if (shell.status === ShellStatus.ERROR) {
    toast({ title: 'Shell unavailable', description: shell.error_message ?? 'Shell error', variant: 'destructive' });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect('/dock/shell');
  }

  // If a process owns this shell, send the user to the process URL instead —
  // that path handles open({ visible: true }) + PTY reconnect for us.
  const linkedProcess = cachedEntitiesByType<AgenticProcess>(AgenticProcess.type).find(
    (p) => p.shell_id === shell.id,
  );
  if (linkedProcess) {
    if (recoverySkips.skipProcessIds.has(linkedProcess.id) || recoverySkips.skipShellIds.has(shell.id)) {
      // Avoid bouncing straight back into the same failing process restore.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(buildShellRecoveryUrl(recoverySkips));
    }
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(withRecoverySearch(`/dock/shell/${linkedProcess.dockPointer.pointer}`, recoverySkips));
  }

  // Plain shell — no linked process.
  try {
    await shell.start({ cols: Shell.DEFAULT_COLS, rows: Shell.DEFAULT_ROWS, workdir: shell.workdir ?? undefined });
  } catch (error) {
    const toastInfo = describeProcessStartError(error);
    toast({ ...toastInfo, variant: 'destructive' });
    await shell.close().catch(() => {});
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(buildShellRecoveryUrl(appendRecoverySkip(recoverySkips, null, shell.id)));
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
}

// ── public entry point ──────────────────────────────────────────────────────

/**
 * Load and validate the shell dock.
 *
 * - Prefetches all shells + agentic processes into the SDK cache (no-pointer path).
 * - If pointer is given, validates the entity exists and is not closed/error.
 * - Sets activeShellId and agenticProcessTypeId (CurrentProcessTypeId) in context.
 * - On invalid entity: shows a toast and redirects to /dock/shell.
 */
export async function loadShell(
  pointer: string | undefined,
  recoverySkips: ShellRecoverySkips = emptyRecoverySkips(),
): Promise<void> {
  _perfLog(`loadShell(${pointer || 'no-pointer'}) start`);

  // Special keyword: create a new shell and redirect to it.
  // Handle before any parallel queries — a running process can add latency.
  if (pointer === 'new_terminal') {
    await loadNewTerminal();
  }

  if (!pointer) {
    await loadDefaultShell(recoverySkips);
    return;
  }

  if (DockPointer.isAgenticProcessPointer(pointer)) {
    const processId = DockPointer.extractAgenticProcessId(pointer);
    await loadAgenticProcessFromPointer(processId, recoverySkips);
    _perfLog('loadShell done (agentic process path)');
    return;
  }

  await loadPlainShell(pointer, recoverySkips);
  _perfLog('loadShell done (shell path)');
}

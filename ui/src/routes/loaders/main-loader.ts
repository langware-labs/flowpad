import {
  AgenticProcess,
  ContextEntitiesEnum,
  dataContext,
  initSdk,
  isProcessActive,
  Project,
  QueryFilter,
  QueryRequest,
  Shell,
  ShellStatus,
  systemTools,
  Trigger,
  TypeId,
} from '@sdk';
import { toast } from '@src/hooks/use-toast';
import { DockPointer } from '@src/navigation';
import { ViewType } from '@src/types/ViewType';
import { TimeIt } from '@src/utils/timeit';
import { redirect, type LoaderFunctionArgs as LoaderArgs } from 'react-router';
import { getBrokenViewUrl, loadFlowFromParams } from './loaders';

// Get allowed view types from the ViewType enum
const ALLOWED_VIEWS = new Set(Object.values(ViewType));
const SKIP_PROCESS_ID_PARAM = 'skip_process_id';
const SKIP_SHELL_ID_PARAM = 'skip_shell_id';

type ShellRecoverySkips = {
  skipProcessIds: Set<string>;
  skipShellIds: Set<string>;
};

function emptyRecoverySkips(): ShellRecoverySkips {
  return {
    skipProcessIds: new Set(),
    skipShellIds: new Set(),
  };
}
/**
 * Ensure compute node is loaded for the current project
 * Project setup is handled by initSdk -> initContext -> setupProject
 */
async function ensureComputeNodeLoaded(): Promise<void> {
  if (dataContext.project && !dataContext.computeNode) {
    await dataContext.refreshProject();
  }

  if (!dataContext.computeNode) {
    const bootstrapNode = dataContext.bootstrapInfo?.default_compute_node;
    if (bootstrapNode?.id && bootstrapNode?.type) {
      await dataContext.setContextEntityTypeId(
        ContextEntitiesEnum.CurrentComputeNodeTypeId,
        new TypeId(bootstrapNode.type, bootstrapNode.id),
      );
    }
  }
}

function isValidViewType(args: LoaderArgs): boolean {
  const { params } = args;
  const { viewType } = params;
  if (!viewType) {
    return false;
  }
  const v = String(viewType ?? '').toLowerCase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ALLOWED_VIEWS.has(v as any);
}

function getDockViewType(args: LoaderArgs): ViewType | undefined {
  if (!isValidViewType(args)) {
    return undefined;
  }
  const { params } = args;
  const { viewType } = params;
  const v = String(viewType ?? '').toLowerCase();
  return v as ViewType;
}

/**
 * Handle the no-pointer case: redirect to the previously active or first alive shell.
 * Returns null if no alive shell exists (caller should clear context and return).
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

  const preferredShells = previousThenRemainingShells(shells, isAlive);
  for (const shell of preferredShells) {
    const url = resolveUrl(shell);
    if (url) return url;
  }

  return null;
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

function buildShellRecoveryUrl(recoverySkips: ShellRecoverySkips = emptyRecoverySkips()): string {
  const searchParams = new URLSearchParams();
  for (const processId of recoverySkips.skipProcessIds ?? []) {
    searchParams.append(SKIP_PROCESS_ID_PARAM, processId);
  }
  for (const shellId of recoverySkips.skipShellIds ?? []) {
    searchParams.append(SKIP_SHELL_ID_PARAM, shellId);
  }
  const queryString = searchParams.toString();
  return queryString ? `/dock/shell?${queryString}` : '/dock/shell';
}

function withRecoverySearch(path: string, recoverySkips: ShellRecoverySkips): string {
  const searchParams = new URLSearchParams();
  for (const processId of recoverySkips.skipProcessIds) {
    searchParams.append(SKIP_PROCESS_ID_PARAM, processId);
  }
  for (const shellId of recoverySkips.skipShellIds) {
    searchParams.append(SKIP_SHELL_ID_PARAM, shellId);
  }
  const queryString = searchParams.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function appendRecoverySkip(
  recoverySkips: ShellRecoverySkips,
  processId?: string | null,
  shellId?: string | null,
): ShellRecoverySkips {
  const nextProcessIds = new Set(recoverySkips.skipProcessIds);
  const nextShellIds = new Set(recoverySkips.skipShellIds);
  if (processId) nextProcessIds.add(processId);
  if (shellId) nextShellIds.add(shellId);
  return {
    skipProcessIds: nextProcessIds,
    skipShellIds: nextShellIds,
  };
}

export function describeProcessStartError(error: unknown): { title: string; description: string } {
  const rawMessage = error instanceof Error ? error.message : String(error ?? '').trim();
  if (/PTY .* not found/i.test(rawMessage)) {
    return {
      title: 'Terminal reattach failed',
      description: rawMessage,
    };
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
 * Load and validate the shell dock.
 * - Prefetches all shells + agentic processes into the SDK cache.
 * - If pointer is given, validates the entity exists and is not closed/error.
 * - Sets activeShellId and agenticProcessTypeId (CurrentProcessTypeId) in context.
 * - On invalid entity: shows a toast and redirects to /dock/shell.
 */
async function loadShell(
  pointer: string | undefined,
  recoverySkips: ShellRecoverySkips = emptyRecoverySkips(),
): Promise<void> {
  _perfLog(`loadShell(${pointer || 'no-pointer'}) start`);
  // Special keyword: create a new shell and redirect to it.
  // Handle before the parallel query to avoid querying AgenticProcess unnecessarily
  // (a running process can add latency to the query).
  if (pointer === 'new_terminal') {
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

  // Prefetch all shells and processes into the entity cache so
  // useActiveTerminals has data on first render without extra fetches.
  const [shells, processes] = await Promise.all([
    Shell.query<Shell>(new QueryRequest({ type: Shell.type, scope: [] })),
    AgenticProcess.query<AgenticProcess>(new QueryRequest({ type: AgenticProcess.type, scope: [], query: new QueryFilter({ match: { visible: true } as Record<string, unknown> }) })),
  ]);

  _perfLog(`loadShell queries done (${shells.length} shells, ${processes.length} processes)`);

  if (!pointer) {
    const redirectUrl = resolveDefaultShell(shells, processes, recoverySkips);
    if (redirectUrl) {
      _perfLog(`loadShell redirect → ${redirectUrl}`);
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(redirectUrl);
    }
    dataContext.setActiveShellId('');
    dataContext.setWorkdir(dataContext.project?.fs_storage_mount_path ?? null);
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, null);
    return;
  }

  if (DockPointer.isAgenticProcessPointer(pointer)) {
    const processId = DockPointer.extractAgenticProcessId(pointer);

    const process =
      processes.find((p) => p.id === processId) ?? (await AgenticProcess.getById(processId).catch(() => null));
    if (!process) {
      toast({ title: 'Session not found', description: `Agentic process does not exist.`, variant: 'destructive' });
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect('/dock/shell');
    }

    let shell: import('@sdk/entities/shell').Shell | null = null;
    try {
      await process.start({ visible: true });
      shell = await process.shell();
    } catch (error) {
      const recoveryUrl = buildShellRecoveryUrl(appendRecoverySkip(recoverySkips, process.id, process.shell_id));
      const toastInfo = describeProcessStartError(error);
      toast({ ...toastInfo, variant: 'destructive' });
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(recoveryUrl);
    }

    if (!shell) {
      const recoveryUrl = buildShellRecoveryUrl(appendRecoverySkip(recoverySkips, process.id, process.shell_id));
      toast({ title: 'Session unavailable', description: 'No shell is linked to this process.', variant: 'destructive' });
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(recoveryUrl);
    }

    dataContext.setActiveShellId(shell.id);
    dataContext.setWorkdir(process.workdir ?? shell.workdir ?? dataContext.project?.fs_storage_mount_path ?? null);
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
    _perfLog('loadShell done (agentic process path)');
  } else {
    // Shell pointer: "shell-<uuid>" or bare UUID
    const shellId = pointer.startsWith(Shell.type + '-') ? pointer.slice(Shell.type.length + 1) : pointer;
    const shell = await Shell.getById(shellId).catch(() => null);

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

    const linkedProcess = processes.find((p) => p.shell_id === shell.id);
    if (linkedProcess) {
      if (recoverySkips.skipProcessIds.has(linkedProcess.id) || recoverySkips.skipShellIds.has(shell.id)) {
        // Avoid bouncing straight back into the same failing process restore.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw redirect(buildShellRecoveryUrl(recoverySkips));
      }
      // Redirect to process URL; agentic_process path handles open({ visible: true }) + reconnect
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(withRecoverySearch(`/dock/shell/${linkedProcess.dockPointer.pointer}`, recoverySkips));
    }

    // Plain shell — no linked process
    await shell.start({ cols: Shell.DEFAULT_COLS, rows: Shell.DEFAULT_ROWS, workdir: shell.workdir ?? undefined });
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
    _perfLog('loadShell done (shell path)');
  }
}

function _perfLog(label: string) {
  const t0 = (window as Record<string, unknown>).__shellNavT0 as number | undefined;
  if (t0 !== undefined) console.log(`[PERF] +${(performance.now() - t0).toFixed(0)}ms ${label}`);
}

export async function loadAgentApp(args: LoaderArgs) {
  const { params } = args;
  const requestUrl = new URL(args.request.url);
  const recoverySkips: ShellRecoverySkips = {
    skipProcessIds: new Set(requestUrl.searchParams.getAll(SKIP_PROCESS_ID_PARAM).filter(Boolean)),
    skipShellIds: new Set(requestUrl.searchParams.getAll(SKIP_SHELL_ID_PARAM).filter(Boolean)),
  };
  const t = new TimeIt(`loadAgentApp(${params['*'] || params.viewType || '/'})`);
  _perfLog(`loadAgentApp start (${params['*'] || params.viewType || '?'})`);

  await initSdk(params);
  t.time('initSdk');

  // Check if service is unavailable - throw error so ErrorBoundary catches it
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bootstrapError = dataContext.bootstrapError as any;
  if (bootstrapError?.isServiceUnavailable || bootstrapError?.type === 'network') {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw dataContext.bootstrapError;
  }

  const { processId, viewType } = params;
  const pointer = params['*'] || '';

  if (!processId && !viewType && /^\/dock\/?$/.test(requestUrl.pathname)) {
    // Bare /dock has no child route to render; send it to the app root instead.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect('/');
  }

  // Handle session context - set process in dataContext (no agent required)
  if (viewType === ViewType.SESSION) {
    const processId = pointer;

    // Set process context (processId is the pointer in URL)
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProcessTypeId,
      processId ? new TypeId(AgenticProcess.type, processId) : null,
    );

    // Set active entity to process
    if (processId) {
      await dataContext.setActiveEntityTypeId(new TypeId(AgenticProcess.type, processId));
      const process = await AgenticProcess.getById(processId).catch(() => null);
      if (process?.project_id) {
        await dataContext.setContextEntityTypeId(
          ContextEntitiesEnum.CurrentProjectTypeId,
          new TypeId(Project.type, process.project_id),
        );
      } else {
        await systemTools.resolveProjectContext(process?.workdir, process ?? undefined);
      }
    }

    // Session view doesn't require agent - just ensure compute node and return
    await ensureComputeNodeLoaded();
    t.time('ensureComputeNode');
    t.done(0.5);
    return;
  }

  if (!processId) {
    // Project is already loaded by initSdk -> setupProject, just ensure compute node
    await ensureComputeNodeLoaded();
    t.time('ensureComputeNode');

    if (viewType === ViewType.SHELL) {
      await loadShell(pointer || undefined, recoverySkips);
      t.time('loadShell');
    }

    if (viewType === ViewType.TRIGGERS) {
      await Trigger.query(new QueryRequest({ type: Trigger.type, scope: [] }));
      t.time('loadTriggers');
    }

    if (viewType === ViewType.PLAN && pointer) {
      const parsed = DockPointer.parsePlanPointer(pointer);
      if (parsed) {
        await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, parsed.agenticProcessTypeId);
        const process = await AgenticProcess.getById(parsed.agenticProcessTypeId.id).catch(() => null);
        if (process?.project_id) {
          await dataContext.setContextEntityTypeId(
            ContextEntitiesEnum.CurrentProjectTypeId,
            new TypeId(Project.type, process.project_id),
          );
        } else {
          await systemTools.resolveProjectContext(process?.workdir, process ?? undefined);
        }
        t.time('loadPlan (set process context)');
      }
    }

    t.done(0.5);
    return;
  }

  const dockViewType = getDockViewType(args);
  if (!dockViewType) {
    t.done(0.5);
    return loadFlowFromParams(args);
  }
  if (!isValidViewType(args)) {
    const brokenViewUrl = getBrokenViewUrl(args);
    console.error(`[LOADER] Invalid view type(${dockViewType}). Redirecting to default view URL:`, brokenViewUrl);
    t.done(0.5);
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(brokenViewUrl);
  }
  t.done(0.5);
  return loadFlowFromParams(args);
}

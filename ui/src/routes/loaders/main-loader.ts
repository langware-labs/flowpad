import {
  AgenticProcess,
  ContextEntitiesEnum,
  dataContext,
  initSdk,
  ProcessorStatus,
  Project,
  QueryRequest,
  Shell,
  ShellStatus,
  systemTools,
  Trigger,
  TypeId,
} from '@sdk';
import { DockPointer } from '@src/navigation';
import { ViewType } from '@src/types/ViewType';
import { redirect, type LoaderFunctionArgs as LoaderArgs } from 'react-router';
import { toast } from '@src/hooks/use-toast';
import { getBrokenViewUrl, loadFlowFromParams } from './loaders';
import { TimeIt } from '@src/utils/timeit';

// Get allowed view types from the ViewType enum
const ALLOWED_VIEWS = new Set(Object.values(ViewType));
const INACTIVE_PROCESS_STATUSES = new Set([ProcessorStatus.COMPLETE, ProcessorStatus.ERROR, ProcessorStatus.INTERRUPTED, ProcessorStatus.INACTIVE]);

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
function resolveDefaultShell(shells: Shell[], processes: AgenticProcess[]): string | null {
  const hiddenStatuses = new Set<string>([ShellStatus.CLOSED, ShellStatus.CLOSING, ShellStatus.ERROR]);
  const activeProcesses = processes.filter((p) => !INACTIVE_PROCESS_STATUSES.has(p.status as ProcessorStatus));
  const isAlive = (s: Shell) => !hiddenStatuses.has(s.status as ShellStatus);

  const resolveUrl = (shell: Shell) => {
    const p = activeProcesses.find((ap) => ap.shell_id === shell.id);
    return `/dock/shell/${(p ?? shell).dockPointer.pointer}`;
  };

  // Prefer the previously active shell (preserves user's tab selection).
  const previousShellId = dataContext.activeShellId;
  const previousShell = previousShellId ? shells.find((s) => s.id === previousShellId && isAlive(s)) : null;
  if (previousShell) return resolveUrl(previousShell);

  // Fall back to first alive shell.
  const aliveShell = shells.find(isAlive);
  if (aliveShell) return resolveUrl(aliveShell);

  return null;
}

/**
 * Load and validate the shell dock.
 * - Prefetches all shells + agentic processes into the SDK cache.
 * - If pointer is given, validates the entity exists and is not closed/error.
 * - Sets activeShellId and agenticProcessTypeId (CurrentProcessTypeId) in context.
 * - On invalid entity: shows a toast and redirects to /dock/shell.
 */
async function loadShell(pointer: string | undefined): Promise<void> {
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
    const newShell = Shell.create(cn, { name });
    await newShell.save(cn.typeId);
    const cwd = dataContext.project?.fs_storage_mount_path ?? undefined;
    await newShell.startPty({ cols: 80, rows: 24, workdir: cwd });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(`/dock/shell/${newShell.dockPointer.pointer}`);
  }

  // Prefetch all shells and processes into the entity cache so
  // useActiveTerminals has data on first render without extra fetches.
  const [shells, processes] = await Promise.all([
    Shell.query<Shell>(new QueryRequest({ type: Shell.type, scope: [] })),
    AgenticProcess.query<AgenticProcess>(new QueryRequest({ type: AgenticProcess.type, scope: [] })),
  ]);

  _perfLog(`loadShell queries done (${shells.length} shells, ${processes.length} processes)`);

  if (!pointer) {
    const redirectUrl = resolveDefaultShell(shells, processes);
    if (redirectUrl) {
      _perfLog(`loadShell redirect → ${redirectUrl}`);
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(redirectUrl);
    }
    dataContext.setActiveShellId('');
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, null);
    return;
  }

  if (DockPointer.isAgenticProcessPointer(pointer)) {
    const processId = DockPointer.extractAgenticProcessId(pointer);

    const process = processes.find((p) => p.id === processId) ?? await AgenticProcess.getById(processId).catch(() => null);
    if (!process) {
      toast({ title: 'Session not found', description: `Agentic process does not exist.`, variant: 'destructive' });
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect('/dock/shell');
    }

    let shell: import('@sdk/entities/shell').Shell;
    try {
      await process.open({ visible: true });
      shell = (await process.getShell())!;
    } catch {
      toast({ title: 'Session unavailable', description: 'This process has been terminated.', variant: 'destructive' });
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect('/dock/shell');
    }

    dataContext.setActiveShellId(shell.id);
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProcessTypeId,
      new TypeId(AgenticProcess.type, processId),
    );
    if (process.project_id) {
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, new TypeId(Project.type, process.project_id));
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
      // Redirect to process URL; agentic_process path handles open({ visible: true }) + reconnect
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect(`/dock/shell/${linkedProcess.dockPointer.pointer}`);
    }

    // Plain shell — no linked process
    await shell.startPty({ cols: Shell.DEFAULT_COLS, rows: Shell.DEFAULT_ROWS, workdir: shell.workdir ?? undefined });
    dataContext.setActiveShellId(shell.id);
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, null);
    if (shell.project_id) {
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, new TypeId(Project.type, shell.project_id));
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
        await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, new TypeId(Project.type, process.project_id));
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
      await loadShell(pointer || undefined);
      t.time('loadShell');
    }

    if (viewType === ViewType.TRIGGERS) {
      await Trigger.query(new QueryRequest({ type: Trigger.type, scope: [] }));
      t.time('loadTriggers');
    }

    if (viewType === ViewType.PLAN && pointer) {
      const parsed = DockPointer.parsePlanPointer(pointer);
      if (parsed) {
        await dataContext.setContextEntityTypeId(
          ContextEntitiesEnum.CurrentProcessTypeId,
          parsed.agenticProcessTypeId,
        );
        const process = await AgenticProcess.getById(parsed.agenticProcessTypeId.id).catch(() => null);
        if (process?.project_id) {
          await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, new TypeId(Project.type, process.project_id));
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

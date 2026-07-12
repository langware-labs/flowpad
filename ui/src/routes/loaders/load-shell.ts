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
  QueryRequest,
  Project,
  Shell,
  ShellStatus,
  systemTools,
  TypeId,
} from '@sdk';
import { closeTerminalTab } from '@src/tabs/useTabs';
import { stampTabRecencyForTarget } from '@src/tabs/tab-recency';
import { showCleanupModal } from '@src/components/recovery/cleanup-modal';
import { notify } from '@src/notifications';
import { buildShellRedirectUrl, detectLayout, DockPointer } from '@src/navigation';
import { ViewType } from '@sdk';
import { projectScope, scopeFilterEqual, type ScopeFilter } from '@src/lib/scope-filter';
import { replace } from 'react-router';
import { perfLog, perfTime } from './_perf';
import {
  describeProcessStartError,
  loadProcess,
  ProcessLoadError,
} from './load-process';
import { loadProject } from './load-project';
import {
  buildProcessCleanup,
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
// switches — the cache is kept warm by the tabs store's (`useTabs`) live subscription.
function cachedEntitiesByType<U>(type: string): U[] {
  const out: U[] = [];
  for (const [typeId, ref] of dataManager.entities.entries()) {
    if (typeId.type !== type) continue;
    const entity = ref.entity as unknown as U | undefined;
    if (entity) out.push(entity);
  }
  return out;
}

// ── CORE: loadShell(shellId) — pure, no redirects ───────────────────────────

/**
 * Load a plain Shell by id: cache-first fetch, attach PTY via `shell.start`,
 * write dataContext. Throws ShellLoadError. Never redirects. Does NOT check
 * for a linked AgenticProcess — the route wrapper is responsible for that
 * dispatch (and will call `loadProcess` instead when a process owns the shell).
 */
export async function loadShell(shellId: string): Promise<Shell> {
  const cached = Shell.getByIdFromCache<Shell>(shellId);
  perfLog(`loadShell cache=${cached ? 'hit' : 'miss'} shellId=${shellId.slice(0, 8)}`);
  const shell =
    cached ??
    (await perfTime('Shell.getById (network)', () =>
      Shell.getById<Shell>(shellId).catch(() => null),
    ));
  if (!shell) {
    throw new ShellLoadError('not_found', shellId);
  }
  if (shell.status === ShellStatus.ERROR) {
    throw new ShellLoadError('error_status', shellId, shell.error_message ?? null);
  }

  // ── Project phase — URL-first: resolve project into context BEFORE
  // `shell.start()` runs, so anything downstream reads the right project.
  if (shell.project_id) {
    await loadProject(new TypeId(Project.type, shell.project_id)).catch(() => {
      // Dangling project_id — fall through to workdir-based resolve below.
      return systemTools.resolveProjectContext(shell.workdir ?? undefined, shell);
    });
  } else {
    // A workdir inside a project mount adopts the shell into it; otherwise this
    // is a genuinely global shell and resolveProjectContext clears the active
    // project to null (the Global scope).
    await systemTools.resolveProjectContext(shell.workdir ?? undefined, shell);
  }

  try {
    await perfTime('shell.start (PTY attach)', () =>
      shell.start({ cols: Shell.DEFAULT_COLS, rows: Shell.DEFAULT_ROWS, workdir: shell.workdir ?? undefined }),
    );
  } catch (cause) {
    throw new ShellLoadError('start_failed', shellId, null, cause);
  }

  dataContext.setActiveShellId(shell.id);
  dataContext.setActiveTerminalTargetTypeId(shell.typeId);
  // Fire-and-forget server stamp (Part 3 §4 D-A): never awaited — loaders
  // must stay fast; the in-cache bump above is the synchronous seed.
  void shell.activate().catch(() => {});
  // Stamp recency on the Tab too — the close-resolver reads Tab.last_active_at,
  // not the Shell row, so without this close-to-most-recently-active falls back
  // to tab_order.
  stampTabRecencyForTarget(Shell.type, shell.id);
  dataContext.setWorkdir(shell.workdir ?? dataContext.project?.fs_storage_mount_path ?? null);
  await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProcessTypeId, null);
  return shell;
}

// Default-tab resolution moved to `resolveNextTab` (src/tabs/tab-candidates.ts):
// the single `resolveActive` resolver applied to the pre-filtered tab list,
// retiring `resolveDefaultTab` (tab-management.md Part 1 §5, Phase 3).

// ── cleanup UI dispatch ─────────────────────────────────────────────────────

/**
 * Render the cleanup outcome to the user. Single cleanup → toast. Two or more
 * → counter modal. Empty → no UI.
 */
function handleCleanups(cleaned: CleanupRecord[]): void {
  if (cleaned.length === 0) return;
  if (cleaned.length === 1) {
    const c = cleaned[0];
    notify.error({ title: c.title, message: c.description });
    return;
  }
  showCleanupModal({ count: cleaned.length });
}

function loadedToPointer(loaded: LoadedNext): string {
  return loaded.kind === 'process'
    ? loaded.process.terminalDockPointer.pointer
    : loaded.shell.dockPointer.pointer;
}

// ── ROUTE: internal branches ────────────────────────────────────────────────

/**
 * Layout-preserving shell URL builder (Part 3 §7): redirects issued while
 * loading a `/win/shell` focus window must stay in the win/ layout — a
 * fallback redirect must not dump the window back into full-app chrome.
 * `loadShellRoute` builds one from the request path and threads it down.
 */
type ShellUrlBuilder = (pointer?: string) => string;

async function routeNewTerminal(shellUrl: ShellUrlBuilder): Promise<never> {
  const cn = dataContext.computeNode;
  if (!cn) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw replace(shellUrl());
  }
  const shells = await Shell.query<Shell>(new QueryRequest({ type: Shell.type, scope: [] }));
  const { nextTerminalName } = await import('@src/components/terminal/rename-rules');
  const name = nextTerminalName(shells.map((s) => ({ name: s.name ?? '' })));
  const cwd = dataContext.project?.fs_storage_mount_path ?? undefined;
  const newShell = Shell.create(cn, { name, workdir: cwd });
  await newShell.save(cn.typeId);
  // Use replace so going BACK doesn't re-trigger this loader and create
  // another terminal.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw replace(shellUrl(newShell.dockPointer.pointer));
}

async function routeDefaultShell(shellUrl: ShellUrlBuilder): Promise<void> {
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
  perfLog(`routeDefaultShell redirect → ${shellUrl(loadedToPointer(result.loaded))}`);
  // Replace (not push): bare /dock/shell is a transient placeholder the user
  // never sees — the loader resolves it to a concrete shell URL synchronously.
  // Using redirect() (PUSH) leaves bare /dock/shell as a no-op history entry,
  // which (a) breaks back/forward navigation across tab clicks and (b) is
  // dropped silently on hard-refresh. Home → BACK still returns to home
  // because the resolved /dock/shell/<id> entry replaces the bare one.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw replace(shellUrl(loadedToPointer(result.loaded)));
}

/**
 * URL-scope ⇐ opened-entity SSOT (the chats-side-menu-wrong-project fix).
 *
 * The opened AgenticProcess's `project_id` is the single source of truth for
 * "what project are we in": it's the project `loadProcess` loads into context.
 * The dock's scope filter (what the Chats navigator reads to list history) must
 * be a PROJECTION of that same id — not the project that happened to be ambient
 * when the scope was seeded at click (`openDock`, NavigationActions). When they
 * diverge (open an oss chat while sapora-streams was active → URL carries
 * sapora's scope), `replace()` the URL onto the same pointer carrying the
 * process's own project scope. This runs at LOAD, so it also corrects deep
 * links / hard refresh / back-forward, not just the click path. Projectless
 * targets keep whatever scope was seeded (no entity project to project from).
 *
 * Keyed off entity IDENTITY only and run BEFORE the runtime phase, so the scope
 * follows `project_id` regardless of how `loadProcess` later resolves — PTY
 * soft-failure, a stale-instance unexpected throw, or success all land on the
 * correctly-scoped URL (the runtime then attaches on the redirected re-run).
 */
async function reconcileProcessScope(
  processId: string,
  requestPath: string,
  currentScope?: ScopeFilter | null,
): Promise<void> {
  // Resolve identity only (cache-first; a cheap get-by-id on cold nav).
  const proc =
    AgenticProcess.getByIdFromCache<AgenticProcess>(processId) ??
    (await AgenticProcess.getById<AgenticProcess>(processId).catch(() => null));
  if (!proc?.project_id) return; // projectless / unresolvable target — leave the seeded scope as-is
  const want = projectScope(proc.project_id);
  if (currentScope && scopeFilterEqual(currentScope, want)) return; // already aligned — no redirect loop
  // NOTE: this scope-align redirect drops the incoming URL's query options
  // (`?sideWindows=dir`, etc.) — `requestPath` is pathname-only (loaders.ts:73
  // strips the query before it reaches here) and this DockPointer seeds
  // options=undefined. Carrying deep-link options through the redirect needs the
  // loader `requestPath` contract to include the search string (touches
  // detectLayout / buildShellRedirectUrl across all routes) — tracked separately;
  // not fixed here. See dir_panel_scroll.md.ts for the affected deep-link.
  const url = new DockPointer(ViewType.SHELL, proc.terminalDockPointer.pointer, undefined, detectLayout(requestPath))
    .withScopeFilter(want)
    .toUrl(requestPath);
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw replace(url);
}

async function routeProcessPointer(
  processId: string,
  shellUrl: ShellUrlBuilder,
  requestPath: string,
  currentScope?: ScopeFilter | null,
): Promise<void> {
  // Align the URL scope to the opened process's project (SSOT) BEFORE the
  // runtime phase. Throws a `replace()` redirect when diverged; on the re-run
  // the scopes match (no-op) and the runtime attaches under the right scope.
  // Independent of `loadProcess` outcome, so a degraded/soft/failed attach can
  // no longer strand the side menu on the ambient project.
  await reconcileProcessScope(processId, requestPath, currentScope);

  try {
    await loadProcess(processId);
    // Successful load — clear any prior runtime-error banner.
    dataContext.setTerminalRuntimeError(null);
    return;
  } catch (e) {
    if (!(e instanceof ProcessLoadError)) throw e;

    // Soft failure — the entity exists, only the runtime is broken (PTY
    // died, shell entity missing, project dangling, …). DO NOT redirect:
    // keep the user on their requested URL and surface a banner with
    // per-kind recovery. This is what prevents the silent-jump-to-stale-
    // sibling class of bugs after a backend restart. (Scope is already
    // aligned above, before this phase ran.)
    if (e.severity === 'soft') {
      dataContext.setActiveTerminalTargetTypeId(
        new TypeId(AgenticProcess.type, processId),
      );
      dataContext.setTerminalRuntimeError({
        kind: e.kind as Exclude<typeof e.kind, 'entity_not_found'>,
        processId,
        shellId: e.shellId ?? null,
      });
      // No toast — ``TerminalRuntimeErrorBanner`` (mounted in
      // InteractiveTerminal) reads the dataContext slot and renders a
      // persistent banner with the recovery action. A toast on top of
      // that would be redundant.
      return;
    }

    // Hard failure — the URL itself is dead. Fall back to the next
    // candidate and ``replace()`` so BACK doesn't re-trigger this loader.
    const directCleanup = buildProcessCleanup(e);
    const next = await loadNextProcess({
      excludeIds: new Set([processId]),
      projectId: dataContext.project?.id ?? null,
    });
    handleCleanups([directCleanup, ...next.cleaned]);
    if (!next.loaded) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw replace(shellUrl());
    }
    const fallbackPointer = loadedToPointer(next.loaded);
    const requestedProc = AgenticProcess.getByIdFromCache<AgenticProcess>(processId);
    const requestedName = requestedProc?.name ?? requestedProc?.displayName ?? `${processId.slice(0, 8)}…`;
    const fallbackName =
      next.loaded.kind === 'process'
        ? next.loaded.process.name ?? next.loaded.process.displayName ?? fallbackPointer
        : next.loaded.shell.name ?? fallbackPointer;
    notify.error({
      title: `Terminal "${requestedName}" not found`,
      message: `${directCleanup.title} — opened "${fallbackName}" instead.`,
    });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw replace(shellUrl(fallbackPointer));
  }
}

async function routePlainShellPointer(pointer: string, shellUrl: ShellUrlBuilder): Promise<void> {
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
    throw replace(shellUrl(linkedProcess.terminalDockPointer.pointer));
  }

  // Cache miss — cold navigation (hard refresh / deep link / page.goto): the
  // loader runs before the tabs store (`useTabs`) warms the cache. The shell carries
  // its owner directly (Shell.agentic_process_id, the reverse of
  // AgenticProcess.shell_id), so a plain get-by-id resolves ownership — no
  // reverse scan over processes.
  const shell = await Shell.getById<Shell>(shellId).catch(() => null);
  if (shell?.agentic_process_id) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw replace(shellUrl(new TypeId(AgenticProcess.type, shell.agentic_process_id).toString()));
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
        throw replace(shellUrl(recovered.terminalDockPointer.pointer));
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
      throw replace(shellUrl());
    }
    const fallbackPointer = loadedToPointer(next.loaded);
    notify.error({
      title: 'Opened a different terminal',
      message: `Couldn't load ${shellId.slice(0, 8)}… (${directCleanup.title}) — opened ${fallbackPointer} instead.`,
    });
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw replace(shellUrl(fallbackPointer));
  }
}

// buildProcessCleanup (the direct-link process mapper) is imported from
// load-next-process — single source of truth shared with the in-loader path.
async function buildShellCleanupForRoute(e: ShellLoadError): Promise<CleanupRecord> {
  switch (e.kind) {
    case 'not_found':
      return { kind: 'shell_not_found', shellId: e.shellId, title: 'Shell not found', description: 'This terminal no longer exists.' };
    case 'error_status':
      return { kind: 'shell_error_status', shellId: e.shellId, title: 'Shell unavailable', description: e.errorMessage ?? 'Shell error' };
    case 'start_failed': {
      await closeTerminalTab(new TypeId(Shell.type, e.shellId)).catch(() => {});
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
export async function loadShellRoute(
  pointer: string | undefined,
  requestPath: string = '/dock/shell',
  currentScope?: ScopeFilter | null,
): Promise<void> {
  perfLog(`loadShellRoute(${pointer || 'no-pointer'}) start`);

  // All redirects below preserve the request's layout keyword (dock/dev/win)
  // so a /win/shell focus window never falls back into full-app chrome (§7).
  const shellUrl: ShellUrlBuilder = (p?: string) => buildShellRedirectUrl(requestPath, p);

  // Gate on the FlowSync WS being OPEN. The dispatch chain below
  // (loadProcess → process.start → shell.attachPty → _reattach → callActionOverWS)
  // throws synchronously when the socket isn't connected, which on cold tabs
  // races against initSdk's fire-and-forget connect. 5 s budget; on timeout we
  // surface a toast and fall through (the existing redirect-on-failure chain
  // still applies if the downstream WS call ultimately fails).
  try {
    await perfTime('connectionManager.waitForConnected', () =>
      connectionManager.waitForConnected(5000),
    );
  } catch {
    notify.error({
      title: 'No realtime connection',
      message: 'Terminal may be unresponsive until the connection recovers.',
    });
  }

  if (pointer === 'new_terminal') {
    await routeNewTerminal(shellUrl);
  }

  if (!pointer) {
    await routeDefaultShell(shellUrl);
    return;
  }

  if (DockPointer.isAgenticProcessPointer(pointer)) {
    const processId = DockPointer.extractAgenticProcessId(pointer);
    await routeProcessPointer(processId, shellUrl, requestPath, currentScope);
    perfLog('loadShellRoute done (agentic process path)');
    return;
  }

  await routePlainShellPointer(pointer, shellUrl);
  perfLog('loadShellRoute done (shell path)');
}

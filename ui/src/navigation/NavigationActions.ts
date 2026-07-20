import {
  AgenticProcess,
  ComputeNode,
  dataContext,
  DockPointerData,
  type IDockPointer,
  Layout,
  PageId,
  QueryRequest,
  Shell,
  toplog,
  TypeId,
  VFSPath,
  ViewType,
} from '@sdk';
import { NavigateFunction } from 'react-router';
import type { ViewMode } from '@src/contexts/view-mode-context';
import { DockPointer, HIGHLIGHT_PARAM } from './DockPointer';
import { dockPointerForFile } from './local-file-pointer';
import { FileOptions, TabOptions } from './types';
import { preserveWindowLayout, stripDockPortion } from './url-builder';
import { allScope, projectScope } from '@src/lib/scope-filter';

// Always returns a record (possibly empty) so consumers can read keys without
// optional-chaining. An earlier version returned `undefined` for empty input,
// which made every consumer responsible for `?.` — `openShellProcess` missed
// one and crashed on option-less opens (Quick Create from Home). `openDock`
// treats an empty record the same as no extra options.
function toStringRecord(obj?: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  if (!obj) return result;
  for (const [key, value] of Object.entries(obj)) {
    if (value == null || value === false || typeof value === 'object') continue;
    result[key] = typeof value === 'string' ? value : `${value as number | boolean}`;
  }
  return result;
}

let pendingDockNavigationUrl: string | null = null;

// View types whose dock adopts the current project's scope when opened without an
// explicit one (see openDock). These are the project-aware browser surfaces: the
// minted Tab attaches to the active project (project tab) or stays global. SHELL
// is included so the Chats/worker rail seeds the active project's scope onto the
// URL — the ChatsNavigator reads currentDock.scopeFilter to filter history, exactly
// like assets/explorer/triggers (SHELL's tabHash ignores scope, so the open
// session's identity is unaffected).
export const SCOPE_SEEDED_VIEWS: ReadonlySet<ViewType> = new Set([
  ViewType.ASSETS,
  ViewType.TRIGGERS,
  ViewType.EXPLORER,
  ViewType.SHELL,
]);

/**
 * NavigationActions - Navigation actions implementation
 *
 * Core principle: All actions update URL (URL-first architecture)
 * Navigation.openDock(pointer) is the basic method, all shortcuts call it
 *
 * Uses relative navigation: takes current URL and replaces the dock portion
 */
export class NavigationActions {
  constructor(
    private navigate: NavigateFunction,
    private currentDock: DockPointer | null = null,
  ) {
    NavigationActions.clearCommittedPendingNavigation();
  }

  private static getCurrentBrowserUrl(): string {
    return `${window.location.pathname}${window.location.search}`;
  }

  /** The `?viewMode` on the LIVE browser URL, or null. Used for view-mode
   *  stickiness seeding — always current, unlike the React-state `currentDock`
   *  mirror which lags during the first navigation after a hard page load. */
  private static currentBrowserViewMode(): ViewMode | null {
    try {
      return DockPointer.fromUrl(NavigationActions.getCurrentBrowserUrl()).viewMode;
    } catch {
      return null;
    }
  }

  private static needsRouterFallback(): boolean {
    return typeof navigator !== 'undefined' && /\bjsdom\b/i.test(navigator.userAgent);
  }

  private static clearCommittedPendingNavigation(): void {
    if (pendingDockNavigationUrl && pendingDockNavigationUrl === NavigationActions.getCurrentBrowserUrl()) {
      pendingDockNavigationUrl = null;
    }
  }

  private markPendingNavigation(targetUrl: string): void {
    pendingDockNavigationUrl = targetUrl;
    window.setTimeout(() => {
      if (pendingDockNavigationUrl === targetUrl && NavigationActions.getCurrentBrowserUrl() !== targetUrl) {
        pendingDockNavigationUrl = null;
      }
    }, 1000);
  }

  // `viewType:pointer` label for the navigation toplog trace.
  private static dockLabel(d: { viewType: string; pointer?: string | null } | null): string | null {
    return d ? `${d.viewType}:${d.pointer ?? ''}` : null;
  }

  private commitBrowserNavigation(fullUrl: string, routerUrl: string): void {
    this.markPendingNavigation(fullUrl);

    const from = NavigationActions.getCurrentBrowserUrl();
    const willPush = from !== fullUrl;
    toplog.log('navigation', 'commitBrowserNavigation', {
      from,
      to: fullUrl,
      routerUrl,
      willPushState: willPush,
      routerFallback: NavigationActions.needsRouterFallback(),
      historyLen: window.history.length,
    });
    if (willPush) {
      window.history.pushState(null, '', fullUrl);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }

    // createMemoryRouter in RTL/jsdom is not wired to window.history/popstate.
    // BrowserRouter is wired to popstate, so calling navigate there would run
    // the route loaders twice.
    if (NavigationActions.needsRouterFallback()) {
      void this.navigate(routerUrl);
    }
  }

  static resetPendingNavigationForTests(): void {
    pendingDockNavigationUrl = null;
  }

  /**
   * Navigate to the home root with `?highlight=<wikiword>` set, so a home/feed
   * element matching that wiki word renders highlighted. URL-carried (shareable,
   * back-button-safe), mirroring the `selected` option — see docs/wikitip.md.
   * Used by the WikiTip backward link ("click here to highlight the feedentry").
   */
  highlight(wikiword: string): void {
    NavigationActions.clearCommittedPendingNavigation();
    const url = `/?${HIGHLIGHT_PARAM}=${encodeURIComponent(wikiword)}`;
    if (NavigationActions.getCurrentBrowserUrl() === url) return;
    this.commitBrowserNavigation(url, url);
  }

  // ========== Core Navigation ==========

  /**
   * Navigate to a dock pointer (base method)
   * All shortcut methods call this
   *
   * Uses relative navigation: strips dock portion from current URL and appends new dock
   *
   * @param pointer - DockPointer to navigate to, or null to close dock
   */
  openDock(pointer: DockPointer | null): void;
  openDock(pointer: IDockPointer, extraOptions?: Record<string, string>): void;
  openDock(pointer: IDockPointer | DockPointer | null, extraOptions?: Record<string, string>): void {
    NavigationActions.clearCommittedPendingNavigation();
    const currentPath = window.location.pathname;
    const currentUrl = NavigationActions.getCurrentBrowserUrl();

    toplog.log('navigation', 'openDock', {
      target:
        pointer === null
          ? null
          : `${(pointer as IDockPointer).viewType ?? '?'}:${(pointer as IDockPointer).pointer ?? ''}`,
      currentDock: NavigationActions.dockLabel(this.currentDock),
      currentUrl,
      extraOptions,
    });

    if (pointer === null) {
      if (this.currentDock === null) {
        toplog.log('navigation', 'openDock(null) no-op (already not on a dock URL)', { currentUrl });
        return; // already not on a dock URL
      }
      // Root-level dock URLs strip to '' — and navigate('') is a react-router
      // relative no-op, so close-dock silently did nothing outside the
      // /agent|/flow prefixed namespaces. Normalize to the app root.
      const baseUrl = stripDockPortion(currentPath) || '/';
      this.navigateToBaseUrl(baseUrl);
      return;
    }

    const base = pointer instanceof DockPointer ? pointer : new DockPointer(pointer);
    let dock =
      extraOptions && Object.keys(extraOptions).length > 0
        ? new DockPointer(base.viewType, base.pointer, { ...base.options, ...extraOptions }, base.layout, base.page)
        : base;

    // URL-first default scope for scope-aware surfaces (assets, triggers, file
    // explorer): a dock opened WITHOUT an explicit scope (no `scope-*` keys →
    // `scopeFilter === null`) adopts the current project's scope — project mode
    // when a project is in context (so the minted Tab attaches to that project),
    // else "all". This puts the scope on the URL where the loader and
    // Tab.getFromDockPointer can read it, instead of leaving it to component
    // state (which the tab can't see). An explicit scope (incl. `all`) is
    // respected untouched. This is what makes the left-rail Triggers / Files
    // icons open a project tab when a project is active and a global one
    // otherwise — exactly like the Assets icon.
    if (dock.viewType && SCOPE_SEEDED_VIEWS.has(dock.viewType) && dock.scopeFilter === null) {
      const projectId = dataContext.project?.id ?? null;
      dock = dock.withScopeFilter(projectId ? projectScope(projectId) : allScope());
    }

    // Inherit the live URL's ?viewMode unless the target names its own (mirrors
    // the scope-seed above); explicit target / ViewToggle mode still wins. Since
    // useDockViewModeOverrideSync now adopts the URL's mode into the persisted
    // preference on load, this inheritance matters only for navigations issued
    // BEFORE that adopt effect commits (e.g. a redirect right after a hard load
    // on a ?viewMode URL) — not for general mode stickiness.
    if (dock.viewMode === null) {
      const liveViewMode = NavigationActions.currentBrowserViewMode() ?? this.currentDock?.viewMode ?? null;
      if (liveViewMode) dock = dock.withViewMode(liveViewMode);
    }

    if (this.currentDock?.equals(dock)) {
      toplog.log('navigation', 'openDock no-op (currentDock equals target)', {
        dock: NavigationActions.dockLabel(dock),
      });
      return; // already at this pointer, no-op
    }

    const layout = preserveWindowLayout(currentPath, dock.layout);
    const targetDock =
      layout === dock.layout ? dock : new DockPointer(dock.viewType, dock.pointer, dock.options, layout, dock.page);
    const fullUrl = targetDock.toUrl(currentPath);

    if (currentUrl === fullUrl || pendingDockNavigationUrl === fullUrl) {
      toplog.log('navigation', 'openDock no-op (URL already current/pending)', {
        currentUrl,
        fullUrl,
        pending: pendingDockNavigationUrl,
      });
      return;
    }

    if (import.meta.env.DEV) {
      try {
        const roundTrippedUrl = DockPointer.fromUrl(fullUrl).toUrl(currentPath);
        if (roundTrippedUrl !== fullUrl) {
          console.error(`DockPointer URL round-trip mismatch: ${fullUrl} -> ${roundTrippedUrl}`);
        }
      } catch (error) {
        console.error(`DockPointer URL round-trip check failed for ${fullUrl}`, error);
      }
    }

    // For react-router with a basename, we need to navigate relative to the base.
    // Extract just the dock portion (everything from /dock/ or /dev/) from the full URL.
    // This allows navigation to work correctly when the app is mounted at a sub-path.
    const basePath = stripDockPortion(currentPath);
    const url = basePath && fullUrl.startsWith(basePath) ? fullUrl.substring(basePath.length) : fullUrl;

    this.commitBrowserNavigation(fullUrl, url);
  }

  private navigateToBaseUrl(baseUrl: string): void {
    const currentUrl = NavigationActions.getCurrentBrowserUrl();
    if (currentUrl === baseUrl || pendingDockNavigationUrl === baseUrl) {
      toplog.log('navigation', 'navigateToBaseUrl no-op (already there/pending)', {
        currentUrl,
        baseUrl,
        pending: pendingDockNavigationUrl,
      });
      return;
    }

    toplog.log('navigation', 'navigateToBaseUrl (close dock)', {
      from: currentUrl,
      to: baseUrl,
      historyLen: window.history.length,
    });
    this.markPendingNavigation(baseUrl);
    if (NavigationActions.getCurrentBrowserUrl() !== baseUrl) {
      window.history.pushState(null, '', baseUrl);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    if (NavigationActions.needsRouterFallback()) {
      void this.navigate(baseUrl);
    }
  }

  /**
   * Build the absolute deep-link URL for a dock pointer without navigating.
   * Pure helper — used by share/copy-link flows and openInBrowserTab.
   */
  getDockUrl(pointer: IDockPointer | DockPointer): string {
    const base = pointer instanceof DockPointer ? pointer : new DockPointer(pointer);
    const fullUrl = base.toUrl(window.location.pathname);
    return `${window.location.origin}${fullUrl}`;
  }

  /**
   * Open a dock pointer in a separate browser tab named "flowpad-shell".
   *
   * - Reuses the existing browser tab named "flowpad-shell" if one is open,
   *   so repeated clicks land in the same secondary tab instead of spawning new ones.
   * - Leaves the current tab (e.g. the conversation view) untouched.
   *
   * Useful for shell / Claude Code sessions launched from a non-shell view.
   */
  openInBrowserTab(pointer: IDockPointer | DockPointer): void {
    const absoluteUrl = this.getDockUrl(pointer);
    const opened = window.open(absoluteUrl, 'flowpad-shell');
    if (opened) opened.focus();
  }

  /**
   * Open a dock pointer in a NEW browser tab (`_blank`), one per call —
   * unlike {@link openInBrowserTab}, which reuses the single named
   * "flowpad-shell" tab. Used by pop-out flows where each popped entity
   * must get its own window. Inside Electron, the main process's
   * setWindowOpenHandler routes this to the system browser.
   */
  openInNewBrowserTab(pointer: IDockPointer | DockPointer): void {
    window.open(this.getDockUrl(pointer), '_blank', 'noopener,noreferrer');
  }

  /**
   * Open a dock pointer in a chrome-less `win/` focus window
   * (docs/tab-management.md Part 3 §7): builds the absolute URL with
   * Layout.WIN and opens it via `window.open(url, '_blank')`. On the web
   * that's a new browser tab; inside Electron the main process's
   * setWindowOpenHandler carve-out allows same-origin `/win/` URLs so they
   * open as in-app BrowserWindows.
   */
  openDockInWindow(pointer: IDockPointer | DockPointer): void {
    const base = pointer instanceof DockPointer ? pointer : new DockPointer(pointer);
    const winDock = new DockPointer(base.viewType, base.pointer, base.options, Layout.WIN, base.page);
    window.open(this.getDockUrl(winDock), '_blank');
  }

  /**
   * Close the current dock (navigate to base flow URL)
   */
  closeDock(): void {
    //console.log('[NavigationActions] 🚪 closeDock called');
    this.openDock(null);
    //console.log('[NavigationActions] 🚪 closeDock completed');
  }

  // ========== Tab Navigation (Shortcuts) ==========

  openTab(tabType: ViewType, options?: TabOptions): void {
    const pointer = DockPointer.forTab(tabType, {
      ...(options?.pinned !== undefined && { pinned: options.pinned.toString() }),
    });
    this.openDock(pointer);
  }

  /**
   * Open a view on a specific SPA-surface (page). The hub rail/home use this to
   * keep navigation under `page=hub` — `forTab`/`forHome` are desk-only, so
   * routing a hub view through them would silently revert the page to `desk`.
   */
  openPage(page: PageId, viewType: ViewType = ViewType.HOME, pointer?: string): void {
    this.openDock(new DockPointer(viewType, pointer, undefined, undefined, page));
  }

  closeTab(tabType: ViewType): void {
    // Closing a tab doesn't navigate - it's a store action
    // This is an exception to URL-first principle (closing doesn't change URL)
    console.warn('[Navigation] closeTab is not URL-based, implement via store action', tabType);
  }

  switchToTab(tabType: ViewType): void {
    // Switching is the same as opening (idempotent)
    this.openTab(tabType);
  }

  // ========== Content Navigation (Shortcuts) ==========

  openAssetList(typeName: string): void {
    this.openDock(DockPointer.forAssetList(typeName));
  }

  /**
   * Open the Assets dock at its default surface: the project home when a
   * project is in context (project-home only renders under a project scope),
   * else the global "all" list.
   */
  openAssets(): void {
    const projectId = dataContext.project?.id ?? null;
    this.openDock(
      projectId ? DockPointer.forAssetProjectHome({ scope: projectScope(projectId) }) : DockPointer.forAssetList('all'),
    );
  }

  openProject(
    projectId?: string,
    sub?: { roomId?: string | null; tab?: import('@sdk').TypeId | null; sessionId?: string | null },
  ): void {
    this.openDock(DockPointer.forProject(projectId, sub));
  }

  openEditor(path?: string, options?: FileOptions): void {
    const pointer = DockPointer.forFile(path, {
      line: options?.line,
      column: options?.column,
    });
    this.openDock(pointer);
  }

  /**
   * Open a file with the viewer appropriate for its type: markdown documents
   * in the assets markdown editor (share / chat / rendered view), everything
   * else in the code editor. Thin wrapper over `dockPointerForFile` — the one
   * pointer-level dispatch every "open this file" surface shares.
   */
  openFile(path: string, options?: FileOptions): void {
    this.openDock(dockPointerForFile(path, options));
  }

  /**
   * Open a FOLDER in the Assets fs browser — the folder counterpart of
   * `openFile`. `openFile` would render a directory path as an empty file, so
   * any surface that has a directory (file browsers, task artifacts) routes it
   * here. Converts the absolute machine path to the compute-node-relative form
   * the `fs/` pointer expects (handles POSIX `/…` and Windows `C:\…`).
   */
  openFolder(machinePath: string): void {
    let rel = machinePath;
    const cn = dataContext.computeNodeTypeId;
    if (cn) {
      try {
        rel = VFSPath.fromMachinePath(machinePath, cn).entitySubPath;
      } catch {
        // Not an absolute machine path — forAssetFsFolder normalizes it as-is.
      }
    }
    this.openDock(DockPointer.forAssetFsFolder(rel));
  }

  /** Navigate to the default shell view (no specific session) */
  openShellView(): void {
    this.openDock(new DockPointerData(ViewType.SHELL));
  }

  async openShell(
    shellId: string,
    options?: { cwd?: string; startCommand?: string; skipPermissions?: boolean },
  ): Promise<Shell | null> {
    const extraOptions = toStringRecord(options);
    const shell = Shell.getByIdFromCache(shellId) ?? (await Shell.getById(shellId));
    if (!shell) {
      return null;
    }
    this.openDock(shell.dockPointer, extraOptions);
    return shell;
  }

  async openShellProcess(
    agenticProcessId: string,
    options?: { t?: string; windows?: string; activeWindow?: string; viewMode?: string },
  ): Promise<AgenticProcess | null> {
    const extraOptions = toStringRecord(options);
    const process =
      AgenticProcess.getByIdFromCache(agenticProcessId) ?? (await AgenticProcess.getById(agenticProcessId));
    if (!process) {
      return null;
    }
    // ONE surface per process, whatever the mode: the shell dock. Vibe is a
    // rendering mode of that same tab — `extraOptions.viewMode` rides the URL
    // as `?viewMode=vibe` via the openDock options merge, never a second URL
    // family (the display tab identity is gone; legacy /dock/display URLs
    // redirect in canonicalProcessDockPath).
    this.openDock(process.terminalDockPointer, extraOptions);
    return process;
  }

  /**
   * Navigate to any entity by its DockPointerData.
   * Prefer this over openShellProcess when you already have a process object.
   */
  openDockPointer(pointer: IDockPointer, options?: Record<string, string>): void {
    this.openDock(pointer, options);
  }

  /** Open an AgenticProcess in a terminal tab. Route loader calls open(). */
  async openProcessTab(processId: string, options?: Record<string, string>): Promise<void> {
    const process = AgenticProcess.getByIdFromCache(processId) ?? (await AgenticProcess.getById(processId));
    if (!process) return;
    this.openDock(process.terminalDockPointer, options);
  }

  /** Open a plain Shell in a terminal tab. */
  async openShellTab(shellId: string): Promise<void> {
    const shell = Shell.getByIdFromCache(shellId) ?? (await Shell.getById(shellId));
    if (!shell) return;
    this.openDock(shell.dockPointer);
  }

  /**
   * Resolve a worker/session/thread id and navigate to it.
   * Backend auto-discovers worker_type. Returns null when the id is unknown
   * to worker history; caller is expected to surface a toast.
   */
  async openWorkerSession(workerId: string): Promise<AgenticProcess | null> {
    const process = await AgenticProcess.getByWorkerId(workerId).catch((err) => {
      console.error('[NavigationActions.openWorkerSession]', err);
      return null;
    });
    if (!process) return null;
    this.openDock(process.dockPointer);
    return process;
  }

  /**
   * Open a shell by ID, automatically detecting whether it has a linked
   * AgenticProcess and navigating to the correct URL.
   * Use this when you have a shellId but don't know if it's a plain shell or a Claude session.
   */
  async openSession(shellId: string, options?: { skipPermissions?: boolean }): Promise<void> {
    const processes = await AgenticProcess.query<AgenticProcess>(
      new QueryRequest({ type: AgenticProcess.type, scope: [] }),
    );
    const linkedProcess = processes.find((p) => p.shell_id === shellId);
    if (linkedProcess) {
      await this.openShellProcess(linkedProcess.id);
    } else {
      await this.openShell(shellId, options);
    }
  }

  async openNewClaudeProcess(options?: {
    cwd?: string;
    projectId?: string;
    workerType?: 'claude_code' | 'codex' | 'copilot';
  }): Promise<{ processId: string; shellId: string | null; dockPointer: IDockPointer } | null> {
    try {
      const computeNode = dataContext.computeNode;
      if (!computeNode) {
        console.error('[NavigationActions] No compute node');
        return null;
      }
      const agenticProcess = await computeNode.createProcess(
        {
          workdir: options?.cwd || dataContext.project?.fs_storage_mount_path,
          projectId: options?.projectId ?? dataContext.project?.id,
          ...(options?.workerType ? { workerType: options.workerType } : {}),
        },
        { watchProcess: false, visible: true },
      );
      return {
        processId: agenticProcess.id,
        shellId: agenticProcess.shell_id ?? null,
        dockPointer: agenticProcess.dockPointer,
      };
    } catch (error) {
      console.error('[NavigationActions] Error creating AgenticProcess:', error);
      return null;
    }
  }

  async openNewShell(options?: {
    cwd?: string;
    startCommand?: string;
    computeNode?: ComputeNode;
    skipNavigate?: boolean;
    projectId?: string;
  }): Promise<{ shellId: string } | null> {
    try {
      const cn = options?.computeNode ?? dataContext.computeNode;
      if (!cn) {
        console.error('[NavigationActions] No compute node');
        if (!options?.skipNavigate) this.openShellView();
        return null;
      }
      const { nextTerminalName } = await import('@src/components/terminal/rename-rules');
      const shells = await Shell.list(cn.id);
      const name = nextTerminalName(shells.map((s) => ({ name: s.name ?? '' })));
      // For sandbox compute nodes the project's host path is meaningless;
      // fall back to the node's own mount path (e.g. /home/user) instead.
      const cwd =
        options?.cwd ||
        (options?.computeNode
          ? (options.computeNode.fs_storage_mount_path ?? undefined)
          : dataContext.project?.fs_storage_mount_path) ||
        undefined;
      const newShell = Shell.create(cn, { name, workdir: cwd });
      // Project consolidation (Path A, 2026-05-09): every Shell carries a
      // real ``project_id``. Prefer the caller-pinned project, then the
      // active dock project; the backend's Shell.save defaults to the
      // bootstrap ``@local`` project if both are absent.
      const pinnedProjectId = options?.projectId ?? dataContext.project?.id ?? null;
      if (pinnedProjectId) newShell.project_id = pinnedProjectId;
      await newShell.save(cn.typeId);
      if (!options?.skipNavigate) {
        await this.openShell(newShell.id, options);
      }
      return { shellId: newShell.id };
    } catch (error) {
      console.error('[NavigationActions] Error creating terminal:', error);
      if (!options?.skipNavigate) this.openShellView();
      return null;
    }
  }

  /**
   * Open the plan viewer for a plan file. Addresses the plan by its **VFS path**
   * (race-free — independent of the fs-records scanner having minted the PLAN
   * entity, and of the owning process still being alive). The originating
   * process — needed only for Execute/Update — is read from the current process
   * context entity, not the URL. `agenticProcessTypeId` is retained in the
   * signature so the live call sites stay unchanged; it is intentionally unused.
   * @param _agenticProcessTypeId - (unused) TypeId of the owning AgenticProcess
   * @param filePath - Absolute path to plan .md file
   */
  openPlan(_agenticProcessTypeId: TypeId, filePath: string): void {
    this.openDock(DockPointer.forPlanByPath(filePath));
  }

  openDiff(checkpointHash: string): void {
    const pointer = DockPointer.forCheckpoint(checkpointHash);
    this.openDock(pointer);
  }

  openWebApp(port: string): void {
    const pointer = DockPointer.forTab(ViewType.WEB_APP, { port });
    this.openDock(pointer);
  }

  /**
   * Open file explorer with optional path
   * @param path - Optional path to navigate to (file or folder)
   *   - If folder: opens that folder
   *   - If file: opens containing folder with file selected
   *   - If omitted: opens root
   */
  openExplorer(path?: string): void {
    const pointer = DockPointer.forExplorer(path);
    this.openDock(pointer);
  }

  /**
   * Open the show view for an entity's MCP UI
   * @param typeId - TypeId string (e.g., "agent-@my-agent")
   * @param page - Page name
   * @param component - Component name
   */
  openShow(typeId: string, page?: string, component?: string): void {
    const pointer = DockPointer.forShow(typeId, page, component);
    this.openDock(pointer);
  }

  /**
   * Open HOME/LiveStatus view with optional tab and item
   * URL structure: /dock/home/<tab>?item=<item>&scope=<scope>&project=<project>
   *
   * @param tab - Tab name (e.g., "summary", "projects", "sessions")
   * @param item - Optional item within the tab
   * @param options - Optional scope filter options
   * @param options.scope - Scope filter: 'all' | 'global' | 'project'
   * @param options.project - Project encoded name (when scope is 'project')
   */
  openHome(tab?: string, item?: string, options?: { scope?: string; project?: string; expand?: boolean }): void {
    const pointer = DockPointer.forHome(tab, item, options);
    this.openDock(pointer);
  }

  /**
   * Open System Profile view with optional tab and item
   * URL structure: /dock/system_profile/<tab>?item=<item>&scope=<scope>&project=<project>
   *
   * @param tab - Tab name (e.g., "summary", "projects", "sessions", "transcripts")
   * @param item - Optional item within the tab
   * @param options - Optional scope filter options
   * @param options.scope - Scope filter: 'all' | 'global' | 'project'
   * @param options.project - Project encoded name (when scope is 'project')
   */
  openSystemProfile(tab?: string, item?: string, options?: { scope?: string; project?: string }): void {
    const pointer = DockPointer.forSystemProfile(tab, item, options);
    this.openDock(pointer);
  }

  // ========== Lens Navigation ==========

  /**
   * Open lens viewer
   * @param category - Lens category (e.g., "claude")
   * @param type - Lens type (e.g., "transcript", "tasks")
   * @param ref - Reference (e.g., session ID, "projectHash/sessionId")
   * @param options - Optional query params
   */
  openLens(category: string, type: string, ref: string, options?: Record<string, string>): void {
    const pointer = DockPointer.forLens(category, type, ref, undefined, options);
    this.openDock(pointer);
  }

  /**
   * Open tasks view
   * @param taskId - Optional task ID to view/edit
   */
  openTasks(taskId?: string): void {
    const pointer = DockPointer.forTasks(taskId);
    this.openDock(pointer);
  }

  /**
   * Open record search view
   * @param query - Optional initial query string
   * @param filters - Optional filter options
   */
  openSearch(
    query?: string,
    filters?: {
      record_type?: string;
      status?: string;
      scope?: string;
      time_preset?: string;
      time_start?: string;
      time_end?: string;
    },
  ): void {
    const pointer = DockPointer.forSearch(query, filters);
    this.openDock(pointer);
  }

  /**
   * Open settings viewer
   * @param fieldName - Optional field name to scroll to / highlight
   * @param filter - Optional search filter string
   */
  openSettings(fieldName?: string, filter?: string): void {
    const pointer = DockPointer.forSettings(fieldName, filter);
    this.openDock(pointer);
  }

  /**
   * Open the user Preferences screen
   * @param category - Optional category whose tab should be active
   */
  openPreferences(category?: string): void {
    const pointer = DockPointer.forPreferences(category);
    this.openDock(pointer);
  }

  // ========== Entity Navigation ==========

  openEntity(entity: unknown): void {
    // TODO: Determine appropriate dock based on entity type
    // For now, log a warning
    console.warn('[Navigation] openEntity not yet implemented', { entity });
  }

  openCodeRef(codeRef: { path: string }): void {
    if (codeRef.path) {
      // Use openFile to automatically choose the right viewer based on file type
      this.openFile(codeRef.path);
    } else {
      console.warn('[Navigation] openCodeRef called with invalid codeRef', codeRef);
    }
  }

  // ========== History Navigation ==========

  goBack(): void {
    toplog.log('navigation', 'NavigationActions.goBack → navigate(-1)', {
      currentUrl: NavigationActions.getCurrentBrowserUrl(),
      currentDock: NavigationActions.dockLabel(this.currentDock),
      historyLen: window.history.length,
    });
    void this.navigate(-1);
  }

  goForward(): void {
    toplog.log('navigation', 'NavigationActions.goForward → navigate(1)', {
      currentUrl: NavigationActions.getCurrentBrowserUrl(),
      historyLen: window.history.length,
    });
    void this.navigate(1);
  }

  // ========== Sharing ==========

  getShareableUrl(): string {
    const baseUrl = window.location.origin;
    const currentPath = window.location.pathname + window.location.search;
    return `${baseUrl}${currentPath}`;
  }

  async copyShareableUrl(): Promise<boolean> {
    const url = this.getShareableUrl();
    try {
      await navigator.clipboard.writeText(url);
      console.log('[Navigation] Copied shareable URL:', url);
      return true;
    } catch (error) {
      console.error('[Navigation] Failed to copy URL:', error);
      return false;
    }
  }
}

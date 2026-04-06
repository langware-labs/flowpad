import { AgenticProcess, CodeRef, dataContext, DockPointerData, FSItem, type IDockPointer, QueryRequest, Shell, TypeId, ViewType } from '@sdk';
import { NavigateFunction } from 'react-router';
import { DockPointer } from './DockPointer';
import { FileOptions, TabOptions } from './types';
import { buildDockUrl, stripDockPortion } from './url-builder';

function toStringRecord(obj?: Record<string, unknown>): Record<string, string> | undefined {
  if (!obj) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value == null || value === false || typeof value === 'object') continue;
    result[key] = typeof value === 'string' ? value : `${value as number | boolean}`;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * NavigationActions - Navigation actions implementation
 *
 * Core principle: All actions update URL (URL-first architecture)
 * Navigation.openDock(pointer) is the basic method, all shortcuts call it
 *
 * Uses relative navigation: takes current URL and replaces the dock portion
 */
export class NavigationActions {
  constructor(private navigate: NavigateFunction, private currentDock: DockPointer | null = null) {}

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
    const currentPath = window.location.pathname;

    if (pointer === null) {
      if (this.currentDock === null) return; // already not on a dock URL
      const baseUrl = stripDockPortion(currentPath);
      void this.navigate(baseUrl);
      return;
    }

    const base = pointer instanceof DockPointer ? pointer : new DockPointer(pointer);
    const dock = extraOptions ? new DockPointer(base.viewType, base.pointer, { ...base.options, ...extraOptions }, base.layout) : base;

    if (this.currentDock?.equals(dock)) return; // already at this pointer, no-op

    const { viewType, pointer: pointerValue, layout } = dock.toUrlSegments();
    const searchParams = dock.toSearchParams();

    const fullUrl = buildDockUrl(
      currentPath,
      viewType,
      pointerValue,
      Object.fromEntries(searchParams.entries()),
      layout,
    );

    // For react-router with a basename, we need to navigate relative to the base.
    // Extract just the dock portion (everything from /dock/ or /dev/) from the full URL.
    // This allows navigation to work correctly when the app is mounted at a sub-path.
    const basePath = stripDockPortion(currentPath);
    const url = basePath && fullUrl.startsWith(basePath) ? fullUrl.substring(basePath.length) : fullUrl;

    void this.navigate(url);
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

  openEditor(path?: string, options?: FileOptions): void {
    const pointer = DockPointer.forFile(path, {
      line: options?.line,
      column: options?.column,
    });
    this.openDock(pointer);
  }

  /**
   * Open a file with the appropriate viewer based on file extension
   * - .md files → docs viewer
   * - Code files → editor
   * - Add more as needed
   */
  openFile(path: string, options?: FileOptions): void {
    const extension = path.split('.').pop()?.toLowerCase();

    // Determine viewer based on file extension
    if (extension === 'md' || extension === 'markdown') {
      // Open in docs viewer
      this.openDocs(path);
    } else {
      // Default to code editor for all other files
      this.openEditor(path, options);
    }
  }

  /** Navigate to the default shell view (no specific session) */
  openShellView(): void {
    this.openDock(new DockPointerData(ViewType.SHELL));
  }

  async openShell(shellId: string, options?: { startClaude?: boolean; cwd?: string; startCommand?: string; skipPermissions?: boolean }): Promise<Shell | null> {
    const extraOptions = toStringRecord(options);
    const shell = Shell.getByIdFromCache(shellId) ?? await Shell.getById(shellId);
    if (!shell) {
      return null;
    }
    this.openDock(shell.dockPointer, extraOptions);
    return shell;
  }

  async openShellProcess(agenticProcessId: string, options?: { t?: string }): Promise<AgenticProcess | null> {
    const extraOptions = toStringRecord(options);
    const process = AgenticProcess.getByIdFromCache(agenticProcessId) ?? await AgenticProcess.getById(agenticProcessId);
    if (!process) {
      return null;
    }
    this.openDock(process.dockPointer, extraOptions);
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
    const process = AgenticProcess.getByIdFromCache(processId) ?? await AgenticProcess.getById(processId);
    if (!process) return;
    this.openDock(process.dockPointer, options);
  }

  /** Open a plain Shell in a terminal tab. */
  async openShellTab(shellId: string): Promise<void> {
    const shell = Shell.getByIdFromCache(shellId) ?? await Shell.getById(shellId);
    if (!shell) return;
    this.openDock(shell.dockPointer);
  }

  /**
   * Open (or create) an AgenticProcess for a Claude CLI session UUID and navigate to it.
   * Uses AgenticProcess.open() which calls upsertSessionProcess — finds existing or creates
   * without starting a PTY. Then navigates to process.dockPointer.
   */
  async openClaudeSession(sessionId: string): Promise<AgenticProcess | null> {
    try {
      const process = await AgenticProcess.fromClaudeSession(sessionId);
      this.openDock(process.dockPointer);
      return process;
    } catch (err) {
      console.error('[NavigationActions.openClaudeSession]', err);
      return null;
    }
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

  async openNewClaudeProcess(options?: { cwd?: string }): Promise<{ processId: string; shellId: string; dockPointer: IDockPointer } | null> {
    try {
      const { process: agenticProcess, shell } = await AgenticProcess.spawn(
        { workdir: options?.cwd || dataContext.project?.fs_storage_mount_path },
        { watchProcessor: false, watchProcess: false, visible: true },
      );
      if (!shell) {
        console.error('[NavigationActions] AgenticProcess created without shell:', agenticProcess.id);
        return null;
      }
      return { processId: agenticProcess.id, shellId: shell.id, dockPointer: agenticProcess.dockPointer };
    } catch (error) {
      console.error('[NavigationActions] Error creating AgenticProcess:', error);
      return null;
    }
  }

  async openNewShell(options?: { cwd?: string; startCommand?: string; }): Promise<{ shellId: string } | null> {
    try {
      const cn = dataContext.computeNode;
      if (!cn) { console.error('[NavigationActions] No compute node'); this.openShellView(); return null; }
      const { nextTerminalName } = await import('@src/components/terminal/TabbedTerminal');
      const shells = await Shell.list(cn.id);
      const name = nextTerminalName(shells.map(s => ({ name: s.name ?? '' })));
      const newShell = Shell.create(cn, { name });
      await newShell.save(cn.typeId);
      const cwd = options?.cwd || dataContext.project?.fs_storage_mount_path || undefined;
      await newShell.startPty({ cols: 80, rows: 24, workdir: cwd });
      const openedShell = await this.openShell(newShell.id, options);
      return { shellId: openedShell?.id ?? newShell.id };
    } catch (error) {
      console.error('[NavigationActions] Error creating terminal:', error);
      this.openShellView();
      return null;
    }
  }

  /**
   * Open docs viewer with optional file path
   * @param filePath - Optional markdown file path, omit for docs list
   */
  openDocs(filePath?: string): void {
    const pointer = DockPointer.forDocs(filePath || '');
    this.openDock(pointer);
  }

  /**
   * Open plan viewer with file path
   * @param agenticProcessTypeId - TypeId of the owning AgenticProcess
   * @param filePath - Absolute path to plan .md file
   */
  openPlan(agenticProcessTypeId: TypeId, filePath: string): void {
    const pointer = DockPointer.forPlan(agenticProcessTypeId, filePath);
    this.openDock(pointer);
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

  /**
   * Open execute flow viewer with optional options
   * @param options - Optional options object with file and session
   * @param options.file - Optional FSItem to execute (provides full VFS context)
   * @param options.machineSessionId - Optional machine session identifier (used by worker-sessions-panel)
   */
  openExecuteFlow(options?: { file?: FSItem; machineSessionId?: string }): void {
    // Use vfsPath.absVfsPath to get normalized path without vfs:// protocol
    const pointer = DockPointer.forExecuteFlow({
      vfsAbsPath: options?.file?.vfsPath.absVfsPath,
      machineSessionId: options?.machineSessionId,
    });
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
  openSearch(query?: string, filters?: { record_type?: string; status?: string; scope?: string; time_preset?: string; time_start?: string; time_end?: string }): void {
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

  // ========== Entity Navigation ==========

  openEntity(entity: unknown): void {
    // TODO: Determine appropriate dock based on entity type
    // For now, log a warning
    console.warn('[Navigation] openEntity not yet implemented', { entity });
  }

  openCodeRef(codeRef: CodeRef): void {
    if (codeRef.path) {
      // Use openFile to automatically choose the right viewer based on file type
      this.openFile(codeRef.path);
    } else {
      console.warn('[Navigation] openCodeRef called with invalid codeRef', codeRef);
    }
  }

  // ========== History Navigation ==========

  goBack(): void {
    void this.navigate(-1);
  }

  goForward(): void {
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

import { AgenticProcess, ClaudeSession, Layout, Project, Shell, TypeId, VFSPath, type IDockPointer } from '@sdk';
import { VIEW_SLOTS, ViewSlot, ViewType, VIEWER_REGISTRY } from '../types/ViewType';
import { NavigationError, NavigationErrorType } from './NavigationError';
import { buildDockUrl, parseDockUrl, parseQueryParams } from './url-builder';
import { isValidView } from './validators';
import { AssetDocPointer } from './AssetDocPointer';
import { AssetEditor, AssetMode, AssetRoutingMethod, editorForType } from './asset-doc-types';
import {
  ALL_SCOPE_FILTER,
  dockOptionsToScopeFilter,
  scopeFilterKey,
  scopeFilterToDockOptions,
  withScopeFilterOptions,
  type ScopeFilter,
} from '@src/lib/scope-filter';
import {
  dockOptionsToSideWindows,
  withSideWindowsOptions,
  type SideWindowsState,
} from '@src/lib/side-windows';

/**
 * Lens pointer structure for sub-routing within lens viewer
 */
export interface LensPointerParts {
  category: string; // e.g., "claude", "session"
  type: string; // e.g., "transcript"
  ref: string; // e.g., base64url encoded vfs path, session id
}

/**
 * DockPointer represents a specific location in the UI layout system
 * Parsed from URL structure: /:layout/:viewType/:pointer[?options]
 * Layout defaults to 'dock' for backward compatibility
 *
 * Core principle: Parse and validate layout URLs, apply state to viewer store
 */
export class DockPointer implements IDockPointer {
  /** Check if a shell pointer refers to an AgenticProcess (pointer is a TypeId like "agentic_process-<id>") */
  static isAgenticProcessPointer(pointer?: string): boolean {
    return !!pointer?.startsWith(AgenticProcess.type + TypeId.DELIMITER);
  }

  /** Extract the entity ID from an agentic_process pointer */
  static extractAgenticProcessId(pointer: string): string {
    return pointer.slice(AgenticProcess.type.length + TypeId.DELIMITER.length);
  }

  /**
   * Canonical terminal tab identity (`TerminalTab.targetTypeId`) for a
   * `/dock/shell` (or `/win/shell`) URL pointer — the single owner of the
   * shell-pointer → tab-key grammar:
   *   - `agentic_process-<id>` → TypeId(agentic_process, id)
   *   - `shell-<id>`           → TypeId(shell, id)
   *   - bare `<id>` (legacy)   → TypeId(shell, id)
   */
  static terminalTargetTypeIdForShellPointer(pointer: string): TypeId {
    if (DockPointer.isAgenticProcessPointer(pointer)) {
      return new TypeId(AgenticProcess.type, DockPointer.extractAgenticProcessId(pointer));
    }
    const shellPrefix = Shell.type + TypeId.DELIMITER;
    const shellId = pointer.startsWith(shellPrefix) ? pointer.slice(shellPrefix.length) : pointer;
    return new TypeId(Shell.type, shellId);
  }

  public readonly viewType?: ViewType | undefined;
  public readonly pointer?: string | undefined;
  public readonly options?: Record<string, string> | undefined;
  public readonly layout: Layout;

  constructor(data: IDockPointer, layout?: Layout);
  constructor(viewType?: ViewType, pointer?: string, options?: Record<string, string>, layout?: Layout);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(viewTypeOrData?: any, pointerOrLayout?: any, options?: any, layout?: any) {
    if (viewTypeOrData && typeof viewTypeOrData === 'object') {
      // IDockPointer overload
      this.viewType = viewTypeOrData.viewType as ViewType | undefined;
      this.pointer = viewTypeOrData.pointer;
      this.options = viewTypeOrData.options;
      this.layout = (pointerOrLayout as Layout) ?? Layout.DOCK;
    } else {
      // Positional overload
      this.viewType = viewTypeOrData;
      this.pointer = pointerOrLayout as string | undefined;
      this.options = options;
      this.layout = layout ?? Layout.DOCK;
    }
  }

  /**
   * The scope filter carried by this dock's options, or null when none is set
   * (so callers apply their own default). This is the single generic accessor
   * for scope-in-URL across every dock — the option-key grammar lives entirely
   * in `lib/scope-filter.ts` (`dockOptionsToScopeFilter`); no dock reads the raw
   * `scope`/`user`/`projects` keys itself.
   */
  get scopeFilter(): ScopeFilter | null {
    return dockOptionsToScopeFilter(this.options);
  }

  /**
   * Clone this pointer with `scope` serialized into its options — the single
   * generic builder for scope-in-URL. Pairs with the `scopeFilter` getter.
   */
  withScopeFilter(scope: ScopeFilter): DockPointer {
    return new DockPointer(
      this.viewType,
      this.pointer,
      withScopeFilterOptions(this.options, scope),
      this.layout,
    );
  }

  /**
   * The set of open side windows + the active one carried by this dock's
   * options, or null when none is set. The single generic accessor for
   * side-windows-in-URL across every dock — the option-key grammar lives
   * entirely in `lib/side-windows.ts`; no surface reads the raw
   * `sideWindows`/`activeSideWindow` keys itself. Consumed via `useSideWindows`.
   */
  get sideWindows(): SideWindowsState | null {
    return dockOptionsToSideWindows(this.options);
  }

  /**
   * Clone this pointer with the side-windows state serialized into its options —
   * the single generic builder for side-windows-in-URL. Pairs with the
   * `sideWindows` getter.
   */
  withSideWindows(state: SideWindowsState): DockPointer {
    return new DockPointer(
      this.viewType,
      this.pointer,
      withSideWindowsOptions(this.options, state),
      this.layout,
    );
  }

  /**
   * Parse dock pointer from URL segments
   * Returns null if invalid (URL validation)
   */
  static fromUrl(url: string): DockPointer;
  static fromUrl(
    viewType: string,
    pointer?: string,
    searchParams?: URLSearchParams,
    layout?: Layout,
  ): DockPointer;
  static fromUrl(
    viewTypeOrUrl: string,
    pointer?: string,
    searchParams?: URLSearchParams,
    layout: Layout = Layout.DOCK, // Default to DOCK for backward compatibility
  ): DockPointer {
    if (pointer === undefined && searchParams === undefined) {
      try {
        const url = new URL(viewTypeOrUrl, 'http://flowpad.local');
        const parsedUrl = parseDockUrl(url.pathname);
        if (parsedUrl?.viewType) {
          return DockPointer.fromUrl(parsedUrl.viewType, parsedUrl.pointer, url.searchParams, parsedUrl.layout);
        }
      } catch {
        // Not a URL-shaped value; continue with the historical viewType parser.
      }
    }

    const viewType = viewTypeOrUrl;

    // Validate view type only
    if (!isValidView(viewType)) {
      throw new NavigationError(NavigationErrorType.UNKNOWN_VIEW, `Invalid view type: ${viewType}`);
    }

    // Decode pointer if provided (may be URL-encoded)
    // Normalize the string "undefined" to actual undefined
    const decodedPointer = pointer && pointer !== 'undefined' ? decodeURIComponent(pointer) : undefined;

    // Parse options from query params
    const options = searchParams ? parseQueryParams(searchParams) : {};

    return new DockPointer(viewType as ViewType, decodedPointer, options, layout);
  }

  /**
   * Create dock pointer from ViewType (shortcut for tab docks)
   */
  static forTab(viewType: ViewType, options?: Record<string, string>, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(viewType, undefined, options || {}, layout);
  }

  /**
   * Triggers dock. The selected trigger id (and the transient "creating" mode)
   * ride in OPTIONS, never `pointer`, so the Triggers tabHash stays `triggers|`
   * — selection/creation are URL-addressable + reload-safe but stay in ONE tab
   * (the same rule the scope filter already follows here). Pair with the
   * `trigger` / `creating` option keys read by TriggersView/TriggersNavigator.
   */
  static forTriggers(
    triggerId?: string,
    opts?: { creating?: string },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const options: Record<string, string> = {};
    if (triggerId) options.trigger = triggerId;
    if (opts?.creating) options.creating = opts.creating;
    return new DockPointer(ViewType.TRIGGERS, undefined, options, layout);
  }

  /**
   * Create dock pointer for file editor
   */
  static forFile(
    path?: string,
    options?: { line?: number; column?: number },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const queryOptions: Record<string, string> = {};
    if (options?.line !== undefined) queryOptions.line = options.line.toString();
    if (options?.column !== undefined) queryOptions.column = options.column.toString();

    return new DockPointer(ViewType.EDITOR, path, queryOptions, layout);
  }

  /**
   * Create dock pointer for checkpoint diff
   */
  static forCheckpoint(checkpointHash: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.DIFF, checkpointHash, undefined, layout);
  }

  /**
   * Create dock pointer for filesystem path
   */
  static forFs(path: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.EDITOR, path, undefined, layout);
  }

  /**
   * Create dock pointer for docs viewer
   * @param filePath - Optional file path, empty string for docs list
   */
  static forDocs(filePath: string = '', layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.DOCS, filePath, undefined, layout);
  }

  /**
   * Create dock pointer for plan viewer
   * @param agenticProcessTypeId - TypeId of the owning AgenticProcess
   * @param filePath - Absolute file path to plan .md file
   */
  static forPlan(agenticProcessTypeId: TypeId, filePath: string, layout: Layout = Layout.DOCK): DockPointer {
    // Strip filePath's leading "/" so the typeid<->path delimiter isn't an
    // embedded "//" in the URL (react-router normalizes "//" to "/",
    // which would silently demote the absolute path to a relative one).
    // parsePlanPointer re-adds it.
    const relPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    const pointer = `${agenticProcessTypeId.toString()}/${relPath}`;
    return new DockPointer(ViewType.PLAN, pointer, undefined, layout);
  }

  /**
   * Parse a plan pointer into its agentic process TypeId and file path parts.
   * Plan pointer format: "agentic_process-<uuid>/<absolute-file-path-without-leading-slash>"
   * Returns null if the pointer doesn't start with a valid agentic_process TypeId.
   */
  static parsePlanPointer(pointer: string): { agenticProcessTypeId: TypeId; filePath: string } | null {
    if (!DockPointer.isAgenticProcessPointer(pointer)) return null;
    // Find the first "/" after the type-id prefix "agentic_process-<uuid>"
    const firstSlash = pointer.indexOf('/');
    if (firstSlash < 0) return null;
    const rawTypeId = pointer.slice(0, firstSlash);
    const relPath = pointer.slice(firstSlash + 1); // skip the delimiter "/"
    if (!relPath) return null;
    // forPlan stripped the leading "/" — plan file paths are always absolute.
    return { agenticProcessTypeId: new TypeId(rawTypeId), filePath: `/${relPath}` };
  }

  /**
   * Create dock pointer for assistance viewer
   * @param taskId - Task ID
   */
  static forAssistance(taskTypeId?: TypeId, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.ASSISTANCE, taskTypeId?.toString(), undefined, layout);
  }

  /**
   * Create dock pointer for file explorer
   * @param path - Optional path to navigate to (file or folder)
   */
  static forExplorer(path?: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.EXPLORER, path, undefined, layout);
  }

  /**
   * Create dock pointer for the skill editor / list under the Assets browser.
   * The standalone Skills view was removed; this helper now routes into the
   * Assets editor (when a name is given) or the Assets list of skills.
   * @param skillName - Optional skill name / vfs path to open in the editor
   */
  static forSkills(skillName?: string, layout: Layout = Layout.DOCK): DockPointer {
    if (skillName) {
      return DockPointer.forAssetEditor('skill', skillName, layout);
    }
    return DockPointer.forAssetList('skill', undefined, layout);
  }

  /**
   * Create dock pointer for an asset editor.
   * Pointer format: "editor/<assetType>/<vfsPath>"
   * @param assetType - The asset type (e.g., "skill", "markdown")
   * @param vfsPath - The VFS or filesystem path to the asset
   * @param options - Query-string options (e.g. `{ editorMode: 'learning' }`)
   */
  static forAssetEditor(
    assetType: string,
    vfsPath: string,
    layout: Layout = Layout.DOCK,
    options?: Record<string, string>,
  ): DockPointer {
    // Delegates to the canonical AssetDocPointer grammar:
    //   editor/<editor>/vfs/<computeNodeTypeId>/<relPath>
    // The editor is derived from the record type (one editor serves many types).
    const editor = editorForType(assetType) ?? AssetEditor.MARKDOWN;
    return AssetDocPointer.forVfs(editor, vfsPath, undefined, options).toDockPointer(layout);
  }

  /**
   * Create dock pointer for an entity-backed asset by its stable TypeId — the
   * preferred, relocation-proof form. The loader resolves it by id (no path
   * discovery), so navigation commits instantly.
   * Pointer format: "editor/<editor>/typeid/<type>-<uuid>"
   */
  static forAssetEditorByTypeId(
    assetType: string,
    typeId: TypeId,
    layout: Layout = Layout.DOCK,
    options?: Record<string, string>,
  ): DockPointer {
    const editor = editorForType(assetType) ?? AssetEditor.MARKDOWN;
    return AssetDocPointer.forTypeId(editor, typeId, options).toDockPointer(layout);
  }

  /**
   * Create dock pointer for a wiki link by name. Resolves to a markdown record
   * at view time; the URL stays at the name form (rename-resilient).
   * Pointer format: "wiki/<encoded name>"
   * URL: /dock/assets/wiki/<encoded name>
   */
  static forWiki(name: string, layout: Layout = Layout.DOCK, space?: string): DockPointer {
    // Canonical grammar: wiki/<space>/<name> (space default @local).
    return AssetDocPointer.forWiki(name, space).toDockPointer(layout);
  }

  /**
   * Create dock pointer for an asset list filtered to a specific type.
   * Pointer format: "list/<typeName>"
   * URL: /dock/assets/list/<typeName>
   */
  static forAssetList(
    typeName: string = 'all',
    options?: { scope?: ScopeFilter },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const base = new DockPointer(ViewType.ASSETS, `list/${typeName}`, undefined, layout);
    return options?.scope ? base.withScopeFilter(options.scope) : base;
  }

  /**
   * Create dock pointer for an asset folder view (filtered list under a folder).
   * Pointer format: "folder/<typeName>/<typeid>/<relPath>"
   *   - typeid is a VFS entity identifier like "compute_node-@local" or "project-<uuid>".
   *   - relPath is the folder path relative to the typeid (may be empty for the vault root).
   * URL: /dock/assets/folder/<typeName>/<typeid>/<relPath>
   */
  static forAssetFolder(
    typeName: string,
    typeid: string,
    relPath: string = '',
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const cleanRel = relPath.replace(/^\/+/, '').replace(/\/+$/, '');
    const pointer = cleanRel
      ? `folder/${typeName}/${typeid}/${cleanRel}`
      : `folder/${typeName}/${typeid}`;
    return new DockPointer(ViewType.ASSETS, pointer, undefined, layout);
  }

  /**
   * Parse a folder pointer into its parts.
   * Returns null if the pointer is not a folder pointer.
   */
  static parseAssetFolderPointer(
    pointer: string | undefined,
  ): { typeName: string; typeid: string; relPath: string } | null {
    if (!pointer || !pointer.startsWith('folder/')) return null;
    const rest = pointer.slice('folder/'.length);
    const firstSlash = rest.indexOf('/');
    if (firstSlash < 0) return null;
    const typeName = rest.slice(0, firstSlash);
    const afterType = rest.slice(firstSlash + 1);
    const secondSlash = afterType.indexOf('/');
    if (secondSlash < 0) {
      // no relPath — pointer addresses the vault root itself
      return { typeName, typeid: afterType, relPath: '' };
    }
    const typeid = afterType.slice(0, secondSlash);
    const relPath = afterType.slice(secondSlash + 1);
    return { typeName, typeid, relPath };
  }

  /**
   * Create dock pointer for workflows viewer
   * @param workflowId - Optional workflow entity ID to view/edit
   */
  static forWorkflows(workflowId?: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.WORKFLOWS, workflowId, undefined, layout);
  }

  /**
   * Create dock pointer for a project's collaboration view, optionally with
   * an active collaboration_room and/or an active tab inside that room, or
   * a focused conversation.
   *
   * URL formats:
   *   /dock/project/<projectId>
   *   /dock/project/<projectId>/collaboration_room/<roomId>
   *   /dock/project/<projectId>/collaboration_room/<roomId>/tab/<typeid>
   *   /dock/project/<projectId>/conversation/<conversationId>
   *
   * `typeid` is the standard TypeId string (e.g. "agentic_process-<uuid>").
   *
   * Precedence: when both `roomId` and `conversationId` are passed, `conversationId`
   * wins — the room shape is dropped to keep the URL unambiguous.
   */
  static forProject(
    projectId?: string,
    sub?: { roomId?: string | null; tab?: TypeId | null; conversationId?: string | null },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    if (!projectId) return new DockPointer(ViewType.PROJECT, undefined, undefined, layout);
    const segments: string[] = [projectId];
    if (sub?.conversationId) {
      segments.push('conversation', sub.conversationId);
    } else if (sub?.roomId) {
      segments.push('collaboration_room', sub.roomId);
      if (sub.tab) {
        segments.push('tab', sub.tab.toString());
      }
    }
    return new DockPointer(ViewType.PROJECT, segments.join('/'), undefined, layout);
  }

  /**
   * Parse a project pointer string.
   *
   * Accepted shapes:
   *   <projectId>
   *   <projectId>/collaboration_room/<roomId>
   *   <projectId>/collaboration_room/<roomId>/tab/<type>-<id>
   *   <projectId>/conversation/<conversationId>
   *
   * Returns nulls for segments that aren't present or the input is malformed.
   */
  static parseProjectPointer(
    pointer: string | undefined | null,
  ): { projectTypeId: TypeId | null; roomId: string | null; tabTypeId: TypeId | null; conversationId: string | null } {
    if (!pointer) return { projectTypeId: null, roomId: null, tabTypeId: null, conversationId: null };
    const parts = pointer.split('/').filter(Boolean);
    // parts[0] identifies the project. It may arrive bare (`<id>`) or as a
    // serialized `<type>-<id>` typeid — route it through TypeId so the type
    // token is parsed by the one object that owns that grammar, never
    // string-matched / prefix-stripped here.
    const projectTypeId = parts[0] ? DockPointer.projectSegmentToTypeId(parts[0]) : null;
    let roomId: string | null = null;
    let tabTypeId: TypeId | null = null;
    let conversationId: string | null = null;
    if (parts[1] === 'conversation' && parts[2]) {
      conversationId = parts[2];
    } else if (parts[1] === 'collaboration_room' && parts[2]) {
      roomId = parts[2];
      if (parts[3] === 'tab' && parts[4]) {
        try {
          tabTypeId = new TypeId(parts[4]);
        } catch {
          tabTypeId = null;
        }
      }
    }
    return { projectTypeId, roomId, tabTypeId, conversationId };
  }

  /**
   * Construct a TypeId, or return null instead of throwing — the shared
   * non-throwing coercion used by the pointer parsers (`targetTypeId`,
   * `projectSegmentToTypeId`) that turn a `<type>-<id>`-or-bare-id segment into
   * a TypeId.
   */
  private static tryTypeId(type: string, id?: string): TypeId | null {
    try {
      return id !== undefined ? new TypeId(type, id) : new TypeId(type);
    } catch {
      return null;
    }
  }

  /**
   * Coerce a project-pointer segment into a `project` TypeId. The segment is a
   * serialized `<type>-<id>` (e.g. `project-<uuid>`) or a bare id; TypeId parses
   * the type token when present, and the project view supplies the type for a
   * bare id. The grammar lives entirely in TypeId — no literal prefixing here.
   */
  private static projectSegmentToTypeId(segment: string): TypeId | null {
    return DockPointer.tryTypeId(Project.type, DockPointer.tryTypeId(segment)?.id ?? segment);
  }

  /**
   * Split a project pointer into `{ projectId, assetSubPointer }`.
   *
   * The sub-pointer is the same shape AssetsPage already accepts at
   * `/dock/assets/<sub>` (e.g. `editor/<typeid>`, `list/<typeName>`,
   * `folder/<typeid>/<relPath>`, `wiki/<name>`) — so the project view can
   * reuse AssetsPage's existing selection parser without inventing new shapes.
   */
  static splitProjectPointer(
    pointer: string | undefined | null,
  ): { projectId: string | null; assetSubPointer: string } {
    if (!pointer) return { projectId: null, assetSubPointer: '' };
    const slash = pointer.indexOf('/');
    if (slash < 0) return { projectId: pointer, assetSubPointer: '' };
    return {
      projectId: pointer.slice(0, slash),
      assetSubPointer: pointer.slice(slash + 1),
    };
  }

  /**
   * Rebase a `ViewType.ASSETS` pointer onto `/dock/project/<projectId>` so
   * navigation initiated by an assets-shaped builder (`forAssetEditor`,
   * `forAssetFolder`, `forAssetList`, `forAssetWiki`) stays inside the project
   * shell. Non-ASSETS pointers and falsy `projectId` pass through unchanged —
   * call sites can use this unconditionally.
   */
  static rebaseAssetsOntoProject(
    p: DockPointer,
    projectId: string | null | undefined,
  ): DockPointer {
    if (!projectId || p.viewType !== ViewType.ASSETS) return p;
    const sub = p.pointer ? `${projectId}/${p.pointer}` : projectId;
    return new DockPointer(ViewType.PROJECT, sub, p.options, p.layout);
  }

  /**
   * Create dock pointer for the inbox, optionally focused on a specific conversation
   * and/or message via query params.
   *
   * URL formats:
   *   /dock/inbox
   *   /dock/inbox?conversation=<id>
   *   /dock/inbox?conversation=<id>&message=<id>
   */
  static forInbox(
    options?: { conversationId?: string | null; messageId?: string | null },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const queryOptions: Record<string, string> = {};
    if (options?.conversationId) queryOptions.conversation = options.conversationId;
    if (options?.messageId) queryOptions.message = options.messageId;
    return new DockPointer(ViewType.INBOX, undefined, Object.keys(queryOptions).length ? queryOptions : undefined, layout);
  }

  /**
   * Create dock pointer for execute flow viewer
   * @param options - Optional options object with vfsAbsPath and session
   * @param options.vfsAbsPath - Optional VFS absolute path to execute (e.g., "compute_node-@local/path/to/file.md")
   * @param options.machineSessionId - Optional machine session identifier (used by worker-sessions-panel)
   */
  static forExecuteFlow(
    options?: { vfsAbsPath?: string; machineSessionId?: string },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const queryOptions: Record<string, string> = {};
    if (options?.vfsAbsPath) queryOptions.vfsAbsPath = options.vfsAbsPath;
    if (options?.machineSessionId) queryOptions.machineSessionId = options.machineSessionId;

    return new DockPointer(ViewType.EXECUTE_FLOW, undefined, queryOptions, layout);
  }

  /**
   * Create dock pointer for shell/terminal viewer
   * @param sessionId - Optional shell session ID (e.g., 'run', 'flowShell', or custom UUID)
   * @param options.cwd - Working directory to cd into before starting the shell
   * @param options.startCommand - Optional command to run on shell startup
   * @param options.skipPermissions - Pass through `--dangerously-skip-permissions` semantics where applicable
   */
  static forShell(
    sessionId?: string,
    options?: { cwd?: string; startCommand?: string; skipPermissions?: boolean },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const queryOptions: Record<string, string> = {};
    if (options?.cwd) queryOptions.cwd = options.cwd;
    if (options?.startCommand) queryOptions.startCommand = options.startCommand;
    if (options?.skipPermissions) queryOptions.skipPermissions = 'true';
    return new DockPointer(ViewType.SHELL, sessionId, queryOptions, layout);
  }

  /**
   * Create dock pointer for HOME/LiveStatus view with optional tab and item
   * URL structure: /dock/home/<tab>?item=<item>&scope=<scope>&project=<project>
   *
   * @param tab - Tab name (e.g., "summary", "projects", "sessions")
   * @param item - Optional item within the tab
   * @param options - Optional scope filter options
   * @param options.scope - Scope filter: 'all' | 'global' | 'project'
   * @param options.project - Project encoded name (when scope is 'project')
   */
  static forHome(
    tab?: string,
    item?: string,
    options?: { scope?: string; project?: string; expand?: boolean },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const queryOptions: Record<string, string> = {};
    if (item) queryOptions.item = item;
    if (options?.scope && options.scope !== 'all') queryOptions.scope = options.scope;
    if (options?.project) queryOptions.project = options.project;
    if (options?.expand) queryOptions.expand = 'true';
    return new DockPointer(ViewType.HOME, tab, queryOptions, layout);
  }

  /**
   * Create dock pointer for System Profile view with optional tab
   * URL structure: /dock/system_profile/<tab>?item=<item>&scope=<scope>&project=<project>
   *
   * @param tab - Tab name (e.g., "summary", "projects", "sessions", "transcripts")
   * @param item - Optional item within the tab
   * @param options - Optional scope filter options
   * @param options.scope - Scope filter: 'all' | 'global' | 'project'
   * @param options.project - Project encoded name (when scope is 'project')
   */
  static forSystemProfile(
    tab?: string,
    item?: string,
    options?: { scope?: string; project?: string },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const queryOptions: Record<string, string> = {};
    if (item) queryOptions.item = item;
    if (options?.scope && options.scope !== 'all') queryOptions.scope = options.scope;
    if (options?.project) queryOptions.project = options.project;
    return new DockPointer(ViewType.SYSTEM_PROFILE, tab, queryOptions, layout);
  }

  /**
   * Create a DockPointer for showing MCP UI components
   *
   * URI format: ui://<entity_vfs>?page=<page>&component=<component>
   * - entity_vfs: TypeId or skill name (e.g., "agent-@my-agent" or "onboarding")
   * - page: Page name (defaults to "index" if not provided)
   * - component: Component name (defaults to "main" if not provided)
   *
   * @param entityVfs - Entity VFS path or skill name
   * @param page - Page name within the entity (default: "index")
   * @param component - Component name within the page (default: "main")
   */
  static forShow(entityVfs: string, page?: string, component?: string, layout: Layout = Layout.DOCK): DockPointer {
    const queryOptions: Record<string, string> = {};
    // Store page and component in query params - apply defaults later in ShowView
    if (page) queryOptions.page = page;
    if (component) queryOptions.component = component;
    return new DockPointer(ViewType.SHOW, entityVfs, queryOptions, layout);
  }

  /**
   * Create a DockPointer for a named app (skill UI). Mounts at /dock/apps/<uname>/<routerPath>.
   * The pointer encodes "<uname>/<routerPath>"; the host splits at the first slash.
   * `routerPath` is opaque to the host — interpreted by the app itself.
   */
  static forApp(
    uname: string,
    routerPath: string = '',
    options?: Record<string, string>,
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const pointer = routerPath ? `${uname}/${routerPath}` : uname;
    return new DockPointer(ViewType.APPS, pointer, options, layout);
  }

  /** Split an APPS pointer into its `{ uname, routerPath }` parts. */
  static parseAppPointer(pointer: string | undefined): { uname: string; routerPath: string } | null {
    if (!pointer) return null;
    const idx = pointer.indexOf('/');
    if (idx < 0) return { uname: pointer, routerPath: '' };
    return { uname: pointer.slice(0, idx), routerPath: pointer.slice(idx + 1) };
  }

  /**
   * Create a DockPointer for the built-in dep-graph viewer at /dock/graph/<type>/<id>.
   * Pointer encodes "<type>/<id>"; the viewer focuses on that entity (local-mode root).
   * Omit the typeId to open the full graph with no focus.
   * Options support `depth` (1-3) and `selected` (a node key to highlight).
   */
  static forGraph(
    typeId?: TypeId | null,
    options?: { depth?: number; selected?: string },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const pointer = typeId ? `${typeId.type}/${typeId.id}` : undefined;
    const queryOptions: Record<string, string> = {};
    if (options?.depth) queryOptions.depth = String(options.depth);
    if (options?.selected) queryOptions.selected = options.selected;
    return new DockPointer(ViewType.GRAPH, pointer, Object.keys(queryOptions).length ? queryOptions : undefined, layout);
  }

  /**
   * Create a DockPointer for the frozen-context viewer at
   * `/dock/graph_context/<id>`. `id` is the GraphContext entity's UUID.
   */
  static forGraphContext(id: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.GRAPH_CONTEXT, id, undefined, layout);
  }

  /** Split a GRAPH pointer into its `{ type, id }` parts. */
  static parseGraphPointer(pointer: string | undefined): { type: string; id: string } | null {
    if (!pointer) return null;
    const idx = pointer.indexOf('/');
    if (idx < 0) return null;
    return { type: pointer.slice(0, idx), id: pointer.slice(idx + 1) };
  }

  /**
   * Create a DockPointer for the docs knowledge browser at
   * `/dock/k-browser/<method>/<value>`. Mirrors the editor addressing grammar:
   * the explicit `<method>` segment (`vfs` | `typeid`) keeps a filesystem path
   * from ever being parsed as a TypeId. `value` is the docs-root vfs path (vfs)
   * or a `<type>-<id>` TypeId (typeid).
   */
  static forKnowledgeBrowser(
    value: string,
    method: 'vfs' | 'typeid' = 'vfs',
    options?: { selected?: string },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    // vfs paths are absolute — strip the leading "/" so the method<->path
    // delimiter isn't an embedded "//" in the URL (react-router normalizes
    // "//" to "/", silently demoting the path to a relative one). The parser
    // re-adds it. Same hazard + fix as forPlan above.
    const cleanValue =
      method === 'vfs' && value.startsWith('/') ? value.slice(1) : value;
    const pointer = `${method}/${cleanValue}`;
    const queryOptions: Record<string, string> = {};
    if (options?.selected) queryOptions.selected = options.selected;
    return new DockPointer(
      ViewType.K_BROWSER,
      pointer,
      Object.keys(queryOptions).length ? queryOptions : undefined,
      layout,
    );
  }

  /** Split a K_BROWSER pointer into `{ method, value }` (default method `vfs`).
   *  vfs values get their leading "/" re-added (forKnowledgeBrowser strips it);
   *  legacy double-slash URLs (`vfs//Users/…`) parse identically. */
  static parseKnowledgeBrowserPointer(
    pointer: string | undefined,
  ): { method: 'vfs' | 'typeid'; value: string } | null {
    if (!pointer) return null;
    const idx = pointer.indexOf('/');
    if (idx < 0) return { method: 'vfs', value: pointer };
    const method = pointer.slice(0, idx) === 'typeid' ? 'typeid' : 'vfs';
    let value = pointer.slice(idx + 1);
    if (method === 'vfs' && value && !value.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(value)) {
      value = `/${value}`;
    }
    return { method, value };
  }

  /**
   * Parse a lens pointer into its parts
   * @param pointer - The full pointer string (e.g., "claude/transcript/abc123")
   */
  static parseLensPointer(pointer: string): LensPointerParts | null {
    const parts = pointer.split('/');
    // Two-segment lenses (category/type, no ref) are valid — e.g.
    // `fs-records/scan`, `fs-records/llm-indexers`, `cli/log`, `claude/context`.
    // Three-or-more-segment lenses additionally carry a ref (e.g.
    // `claude/transcript/<sessionId>`).
    if (parts.length < 2) return null;
    return {
      category: parts[0],
      type: parts[1],
      ref: parts.slice(2).join('/'), // '' when absent; may contain slashes
    };
  }

  /**
   * Create dock pointer for lens viewer
   * @param category - Lens category (e.g., "claude")
   * @param type - Lens type (e.g., "transcript")
   * @param ref - Reference (e.g., encoded vfs path)
   */
  static forLens(
    category: string,
    type: string,
    ref: string,
    layout: Layout = Layout.DOCK,
    options?: Record<string, string>,
  ): DockPointer {
    const pointer = `${category}/${type}/${ref}`;
    return new DockPointer(ViewType.LENS, pointer, options, layout);
  }

  /**
   * Create dock pointer for tasks view.
   * @param taskId - Optional task ID to view/edit
   * @param options.conversationId - Optional conversation id to canonicalise
   *   into the URL — produces `/dock/tasks/<taskId>/conversation/<convId>`.
   *   The task view itself only renders the task; the segment is purely a
   *   canonical anchor (so deep-links from the email / inbox can carry both).
   */
  static forTasks(
    taskId?: string,
    options?: { conversationId?: string; layout?: Layout },
  ): DockPointer {
    const layout = options?.layout ?? Layout.DOCK;
    const pointer = taskId
      ? options?.conversationId
        ? `${taskId}/conversation/${options.conversationId}`
        : taskId
      : undefined;
    return new DockPointer(ViewType.TASKS, pointer, undefined, layout);
  }

  /**
   * Create dock pointer for the dedicated conversation viewer at
   * `/dock/conversation/<conversationId>`. Same UI as the conversation
   * panel embedded in task views — the URL is just a different host for it.
   *
   * URL formats:
   *   /dock/conversation/<conversationId>
   *   /dock/conversation/<conversationId>/message/<messageId>
   *
   * The optional `message` segment deep-links to a specific FlowMessage —
   * the conversation view derives its selected bubble from it (URL-first)
   * and scrolls it into view.
   */
  static forConversation(
    conversationId: string,
    sub?: { messageId?: string | null },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const pointer = sub?.messageId
      ? `${conversationId}/message/${sub.messageId}`
      : conversationId;
    return new DockPointer(ViewType.CONVERSATION, pointer, undefined, layout);
  }

  /**
   * Parse a conversation pointer string.
   *
   * Accepted shapes:
   *   <conversationId>
   *   <conversationId>/message/<messageId>
   *
   * Returns nulls for segments that aren't present or the input is malformed.
   */
  static parseConversationPointer(
    pointer: string | undefined | null,
  ): { conversationId: string | null; messageId: string | null } {
    if (!pointer) return { conversationId: null, messageId: null };
    const parts = pointer.split('/').filter(Boolean);
    const conversationId = parts[0] ?? null;
    const messageId = parts[1] === 'message' && parts[2] ? parts[2] : null;
    return { conversationId, messageId };
  }

  /**
   * Create dock pointer for the dedicated spec viewer at
   * `/dock/spec/<specId>`. Renders the Spec record's metadata and
   * a link back to the source plan + generated tasks.
   */
  static forSpec(specId: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.SPEC, specId, undefined, layout);
  }

  /**
   * Create dock pointer for the record search view
   * @param query - Optional search query string
   * @param filters - Optional filter options
   */
  static forSearch(
    query?: string,
    filters?: { record_type?: string; status?: string; scope?: string; time_preset?: string; time_start?: string; time_end?: string },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const opts: Record<string, string> = {};
    if (query) opts.q = query;
    if (filters?.record_type) opts.record_type = filters.record_type;
    if (filters?.status) opts.status = filters.status;
    if (filters?.scope) opts.scope = filters.scope;
    if (filters?.time_preset) opts.time_preset = filters.time_preset;
    if (filters?.time_start) opts.time_start = filters.time_start;
    if (filters?.time_end) opts.time_end = filters.time_end;
    return new DockPointer(ViewType.SEARCH, undefined, opts, layout);
  }

  /**
   * Create dock pointer for the fs-records scanner lens
   */
  static forFsRecordsScanner(layout: Layout = Layout.DOCK): DockPointer {
    return DockPointer.forLens('fs-records', 'scan', '', layout);
  }

  /**
   * Create dock pointer for the LLM Indexers lens — lists MarkdownIndex
   * entities, lets the user run / view each indexer.
   */
  static forLlmIndexers(layout: Layout = Layout.DOCK): DockPointer {
    return DockPointer.forLens('fs-records', 'llm-indexers', '', layout);
  }

  /**
   * Create a dock pointer for the transcript lens, dispatching by worker.
   *
   * - claude: ref is `<projectEncodedName>/<sessionId>` (legacy claude viewer).
   * - codex/copilot: ref is the URL-encoded absolute path to the
   *   rollout JSONL — the generic viewer fetches it via `useTranscript`.
   */
  static forLensTranscript(
    workerType: 'claude' | 'codex' | 'copilot',
    ref: string,
    layout: Layout = Layout.DOCK,
    options?: Record<string, string>,
  ): DockPointer {
    const safeRef = workerType === 'claude' ? ref : encodeURIComponent(ref);
    return DockPointer.forLens(workerType, 'transcript', safeRef, layout, options);
  }

  /**
   * Create dock pointer for settings viewer
   * @param fieldName - Optional field name to scroll to / highlight
   * @param filter - Optional search filter string
   */
  static forSettings(fieldName?: string, filter?: string, layout: Layout = Layout.DOCK): DockPointer {
    const queryOptions: Record<string, string> = {};
    if (filter) queryOptions.filter = filter;
    return new DockPointer(ViewType.SETTINGS, fieldName, queryOptions, layout);
  }

  /**
   * Check equality with another dock pointer
   */
  equals(other: DockPointer): boolean {
    return (
      this.viewType === other.viewType &&
      this.pointer === other.pointer &&
      this.slot === other.slot &&
      this.layout === other.layout &&
      JSON.stringify(this.options) === JSON.stringify(other.options)
    );
  }

  /**
   * Canonical tab identity for this pointer, or **`null` when the surface is not
   * a tab at all** — the single generic "no tab" signal every consumer honors
   * (`ensureTabForCurrentDock` skips it; the strip's active-key resolves to no
   * chip). Two surfaces have no chip: a **full-bleed** view (e.g. `home`, via the
   * registry `chrome` flag) takes over the panel so there is no strip to sit in;
   * and a **bare shell** (`/dock/shell` with no session — the terminal HOST whose
   * sessions are the actual tabs at `/dock/shell/<session>`). Encoding "no tab"
   * here (not as a special case in each consumer) keeps the whole tab-or-not
   * decision in the one place that owns tab identity.
   *
   * Otherwise identity is ``viewType`` + ``pointer`` ONLY. ``layout`` is excluded
   * on purpose: a ``/win/`` popout and the ``/dock/`` view of the same content are
   * the same Tab (placement is per-client URL state, not tab identity). Transient
   * ``options`` (slot, query params) are excluded too — by default a viewType's
   * sub-state shares one tab (e.g. all settings sub-paths → one "Settings" tab).
   * This string is the natural key the backend stores verbatim as ``Tab.pointer``;
   * canonicalization lives here and NOWHERE else, so there is no cross-language
   * canonicalizer to keep in agreement.
   */
  get tabHash(): string | null {
    if (!this.viewType) return null;
    // A full-bleed surface (Home) takes over the panel — no strip, hence no chip.
    if (VIEWER_REGISTRY[this.viewType]?.chrome === 'fullbleed') return null;
    // A bare shell is the terminal host; only a session-pointer shell is a tab.
    if (this.viewType === ViewType.SHELL && !this.pointer) return null;
    // Assets is a SINGLE tab per scope: every type/folder/editor sub-pointer of
    // one scope folds into ONE tab. Identity = the scope filter (global when
    // unset), NOT the sub-pointer. scopeFilterKey: 'all' | 'user' |
    // 'project:<id>' | 'filter:<0|1>:p1,p2'.
    if (this.viewType === ViewType.ASSETS) {
      return `${ViewType.ASSETS}|${scopeFilterKey(this.scopeFilter ?? ALL_SCOPE_FILTER)}`;
    }
    return `${this.viewType}|${this.pointer ?? ''}`;
  }

  /** Serialize this dock's tab-identity fields (viewType + pointer) as JSON.
   *  This is what Tab.pointer stores in the DB. Returns null if tabHash is null. */
  toJSON(): string | null {
    if (!this.tabHash) return null;
    // Assets identity is the SCOPE, not the sub-pointer. Normalize the pointer to
    // '' and persist the scope (options) + the computed tabHash so: (a) the stored
    // JSON is constant for a given scope regardless of which type was last viewed
    // → the backend mints ONE Tab row per scope; (b) `Tab.dockPointer` rebuilds the
    // same tabHash directly from the stored field; (c) clicking the chip reopens the
    // scoped browser root.
    if (this.viewType === ViewType.ASSETS) {
      return JSON.stringify({
        viewType: ViewType.ASSETS,
        pointer: '',
        options: this.scopeFilter ? scopeFilterToDockOptions(this.scopeFilter) : undefined,
        tabHash: this.tabHash,
      });
    }
    return JSON.stringify({ viewType: this.viewType ?? '', pointer: this.pointer ?? '' });
  }

  /** Deserialize a stored Tab.pointer JSON back to a navigable DockPointer.
   *  Replaces fromTabHash — no opaque string parsing needed. Returns null on malformed input. */
  static fromJSON(json: string): DockPointer | null {
    try {
      const parsed = JSON.parse(json) as {
        viewType?: string;
        pointer?: string;
        options?: Record<string, string>;
      };
      const { viewType, pointer, options } = parsed;
      if (!viewType) return null;
      const dp = DockPointer.fromUrl(viewType, pointer || undefined);
      // Restore scope options (assets identity) so the reconstructed dock's
      // tabHash matches the live nav dock's.
      return options ? new DockPointer(dp.viewType, dp.pointer, options, dp.layout) : dp;
    } catch {
      return null;
    }
  }

  /**
   * The entity this dock targets, as a TypeId — for the tab's denormalized
   * target + project resolution (`Tab.getFromDockPointer`). Pure string parse,
   * no network. Two shapes carry an entity: the type lives IN the pointer
   * (`<type>-<id>` / `…/typeid/<type>-<id>`), or — for a bare-id pointer — in the
   * viewType segment (e.g. `/dock/project/<id>` → `project-<id>`,
   * `/dock/conversation/<id>`). vfs/list/folder/target-less docks → null.
   */
  get targetTypeId(): TypeId | null {
    const pointer = this.pointer;
    if (!pointer) return null;
    // A claude-transcript lens (`claude/transcript/<sessionId>`) targets its
    // ClaudeSession entity (id = session id). Surfacing it here puts lens on the
    // same entity rail as every other dock: the tab mint resolves the session's
    // name and the loader its project — no lens-special naming/project logic.
    if (this.viewType === ViewType.LENS) {
      const lens = DockPointer.parseLensPointer(pointer);
      if (lens?.category === 'claude' && lens.type === 'transcript' && lens.ref && !lens.ref.includes('/')) {
        return DockPointer.tryTypeId(ClaudeSession.type, lens.ref);
      }
    }
    // A PROJECT-rebased asset dock (`/dock/project/<id>/<assetSubPointer>`, the
    // output of `rebaseAssetsOntoProject`) carries its target in the asset
    // sub-pointer, addressed exactly as a plain ASSETS dock would. A
    // typeid-addressed asset surfaces its entity here; a vfs/list/folder/wiki
    // sub-pointer carries no typeid target (its entity is resolved by path via
    // `vfsPath`) — and crucially we must NOT surface the `<id>` project segment
    // as the target, so the path-resolved asset's OWN project wins on the tab.
    const assetSub = this.assetSubPointer;
    if (assetSub !== null) {
      const typeid = this.assetEditorValue(assetSub, AssetRoutingMethod.TYPEID);
      return typeid ? DockPointer.tryTypeId(typeid) : null;
    }
    const candidate = pointer.includes('/typeid/') ? pointer.split('/typeid/').pop() ?? '' : pointer;
    return (
      DockPointer.tryTypeId(candidate) ??
      (this.viewType && !pointer.includes('/') ? DockPointer.tryTypeId(this.viewType, pointer) : null)
    );
  }

  /**
   * The inner asset sub-pointer of a PROJECT-rebased asset dock
   * (`/dock/project/<id>/<assetSubPointer>`) — the same shape a plain
   * `/dock/assets/<sub>` dock carries. Null when this isn't a project dock
   * carrying a sub-pointer (a bare `/dock/project/<id>` has none). This is the
   * un-rebase that lets the tab-mint getters treat a project-shell asset URL
   * identically to a plain assets URL, so the asset's own project is resolved.
   */
  private get assetSubPointer(): string | null {
    if (this.viewType !== ViewType.PROJECT || !this.pointer) return null;
    const { assetSubPointer } = DockPointer.splitProjectPointer(this.pointer);
    return assetSubPointer || null;
  }

  /**
   * Parse an asset sub-pointer and return the `value` of an `editor/<...>/<method>`
   * pointer when it matches `method` (`typeid` → a `<type>-<id>` string, `vfs` →
   * a vfs path), else null. The shared parse-and-match both `targetTypeId` and
   * `vfsPath` use to read their respective addressing form off the same pointer.
   */
  private assetEditorValue(pointer: string | null, method: AssetRoutingMethod): string | null {
    if (!pointer) return null;
    try {
      const ap = AssetDocPointer.parse(pointer);
      return ap.mode === AssetMode.EDITOR && ap.method === method ? ap.value : null;
    } catch {
      /* list/folder/wiki or malformed — not an editor pointer */
      return null;
    }
  }

  /**
   * The VFS path an asset-editor dock addresses (`assets/editor/<editor>/vfs/<path>`),
   * or null for any other shape. Pure parse via the canonical `AssetDocPointer`
   * grammar — no network. Used by `Tab.getFromDockPointer` to resolve a
   * path-addressed asset's project via `getEntityByPath`. Handles both the plain
   * ASSETS dock and the PROJECT-rebased form (un-rebased via `assetSubPointer`).
   */
  get vfsPath(): VFSPath | null {
    const assetsPointer = this.viewType === ViewType.ASSETS ? this.pointer ?? null : this.assetSubPointer;
    const value = this.assetEditorValue(assetsPointer, AssetRoutingMethod.VFS);
    return value ? VFSPath.parse(value) : null;
  }

  /** DEPRECATED: use fromJSON instead. Reconstruct the navigable DockPointer from a
   *  legacy stored `Tab.pointer` (`viewType|sub` string format). Null when invalid.
   *  This method remains for backward compatibility but new code should use fromJSON. */
  static fromTabHash(hash: string): DockPointer | null {
    const i = hash.indexOf('|');
    const viewType = i >= 0 ? hash.slice(0, i) : hash;
    const sub = i >= 0 ? hash.slice(i + 1) : '';
    try {
      return DockPointer.fromUrl(viewType, sub || undefined);
    } catch {
      return null;
    }
  }

  /**
   * Convert to URL segments (for building URLs)
   */
  toUrlSegments(): { viewType: ViewType; pointer?: string; layout: Layout } {
    return {
      viewType: this.viewType!,
      pointer: this.pointer,
      layout: this.layout,
    };
  }

  /**
   * Serialize this DockPointer into the canonical layout URL.
   */
  toUrl(currentPath: string = ''): string {
    if (!this.viewType) {
      throw new NavigationError(NavigationErrorType.UNKNOWN_VIEW, 'Cannot serialize DockPointer without a view type');
    }
    return buildDockUrl(currentPath, this.viewType, this.pointer, this.options, this.layout);
  }

  /**
   * Convert options to URLSearchParams
   */
  toSearchParams(): URLSearchParams {
    if (!this.options) {
      return new URLSearchParams();
    }
    const params = new URLSearchParams();
    Object.entries(this.options).forEach(([key, value]) => {
      if (value !== undefined) {
        params.set(key, value);
      }
    });
    return params;
  }

  /**
   * Get human-readable description of this dock pointer
   */
  toString(): string {
    const optionsStr = this.options && Object.keys(this.options).length > 0 ? ` (${JSON.stringify(this.options)})` : '';
    return `DockPointer(${this.viewType}/${this.pointer}, slot: ${this.slot}${optionsStr})`;
  }

  /**
   * Get the current slot from options, defaulting to TAB if not set
   */
  get slot(): ViewSlot {
    const slotValue = this.options?.slot;
    if (!slotValue || !Object.values(VIEW_SLOTS).includes(slotValue as ViewSlot)) {
      return VIEW_SLOTS.TAB;
    }
    return slotValue as ViewSlot;
  }

  /**
   * Set the slot in options (validated)
   */
  set slot(value: ViewSlot) {
    if (!Object.values(VIEW_SLOTS).includes(value)) {
      throw new Error(`Invalid slot: ${value}. Must be one of: ${Object.values(VIEW_SLOTS).join(', ')}`);
    }
    if (this.options) {
      this.options.slot = value;
    }
  }
}

/**
 * Compute the project-scoped DockPointer for a terminal tab rendered inside
 * the Project (collaboration) view. Prefers the AgenticProcess when the tab
 * is a Claude session; falls back to the plain Shell.
 *
 * The room id is required — tabs inside a collaboration room always belong
 * to one. Keep `process.dockPointer` untouched — this function is the seam.
 */
export function getProcessProjectDockPointer(
  tab: { shell?: { id?: string } | null; agenticProcess?: { id?: string } | null },
  projectId: string,
  roomId: string,
): DockPointer {
  if (tab.agenticProcess?.id) {
    return DockPointer.forProject(projectId, {
      roomId,
      tab: new TypeId('agentic_process', tab.agenticProcess.id),
    });
  }
  if (tab.shell?.id) {
    return DockPointer.forProject(projectId, {
      roomId,
      tab: new TypeId('shell', tab.shell.id),
    });
  }
  return DockPointer.forProject(projectId, { roomId });
}

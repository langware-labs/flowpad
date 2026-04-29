import { AgenticProcess, Layout, TypeId, type IDockPointer } from '@sdk';
import { VIEW_SLOTS, ViewSlot, ViewType } from '../types/ViewType';
import { NavigationError, NavigationErrorType } from './NavigationError';
import { parseQueryParams } from './url-builder';
import { isValidView } from './validators';

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
   * Parse dock pointer from URL segments
   * Returns null if invalid (URL validation)
   */
  static fromUrl(
    viewType: string,
    pointer?: string,
    searchParams?: URLSearchParams,
    layout: Layout = Layout.DOCK, // Default to DOCK for backward compatibility
  ): DockPointer {
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
    const pointer = `${agenticProcessTypeId.toString()}/${filePath}`;
    return new DockPointer(ViewType.PLAN, pointer, undefined, layout);
  }

  /**
   * Parse a plan pointer into its agentic process TypeId and file path parts.
   * Plan pointer format: "agentic_process-<uuid>/<absolute-file-path>"
   * Returns null if the pointer doesn't start with a valid agentic_process TypeId.
   */
  static parsePlanPointer(pointer: string): { agenticProcessTypeId: TypeId; filePath: string } | null {
    if (!DockPointer.isAgenticProcessPointer(pointer)) return null;
    // Find the first "/" after the type-id prefix "agentic_process-<uuid>"
    const firstSlash = pointer.indexOf('/');
    if (firstSlash < 0) return null;
    const rawTypeId = pointer.slice(0, firstSlash);
    const filePath = pointer.slice(firstSlash + 1); // skip the delimiter "/"
    if (!filePath) return null;
    return { agenticProcessTypeId: new TypeId(rawTypeId), filePath };
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
   * Create dock pointer for skills viewer
   * @param skillName - Optional skill name to view/edit
   */
  static forSkills(skillName?: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.SKILLS, skillName, undefined, layout);
  }

  /**
   * Create dock pointer for an asset editor.
   * Pointer format: "editor/<assetType>/<vfsPath>"
   * @param assetType - The asset type (e.g., "skill", "markdown")
   * @param vfsPath - The VFS or filesystem path to the asset
   */
  static forAssetEditor(assetType: string, vfsPath: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.ASSETS, `editor/${assetType}/${vfsPath.replace(/^\//, '')}`, undefined, layout);
  }

  /**
   * Create dock pointer for an asset list filtered to a specific type.
   * Pointer format: "list/<typeName>"
   * URL: /dock/assets/list/<typeName>
   */
  static forAssetList(
    typeName: string = 'all',
    options?: { projectId?: string },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const opts: Record<string, string> = {};
    if (options?.projectId) {
      opts.scope = 'project';
      opts.project_ids = options.projectId;
    }
    return new DockPointer(ViewType.ASSETS, `list/${typeName}`, Object.keys(opts).length ? opts : undefined, layout);
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
  ): { projectId: string | null; roomId: string | null; tabTypeId: TypeId | null; conversationId: string | null } {
    if (!pointer) return { projectId: null, roomId: null, tabTypeId: null, conversationId: null };
    const parts = pointer.split('/').filter(Boolean);
    const projectId = parts[0] ?? null;
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
    return { projectId, roomId, tabTypeId, conversationId };
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
   * Parse a lens pointer into its parts
   * @param pointer - The full pointer string (e.g., "claude/transcript/abc123")
   */
  static parseLensPointer(pointer: string): LensPointerParts | null {
    const parts = pointer.split('/');
    if (parts.length < 3) return null;
    return {
      category: parts[0],
      type: parts[1],
      ref: parts.slice(2).join('/'), // ref might contain slashes
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
   */
  static forConversation(conversationId: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.CONVERSATION, conversationId, undefined, layout);
  }

  /**
   * Create dock pointer for live session view
   * @param processId - Process ID for the session
   */
  static forSession(processId: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.SESSION, processId, undefined, layout);
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

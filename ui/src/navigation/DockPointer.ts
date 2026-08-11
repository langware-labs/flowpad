import {
  AgenticProcess,
  ClaudeSession,
  CredentialsSubview,
  GraphWorkflow,
  Layout,
  PageId,
  Project,
  RemoteWorkerSession,
  Shell,
  TypeId,
  VFSPath,
  WorldViewProjection,
  isWorldViewProjection,
  normalizeRetiredDockPointer,
  normalizeWorldViewDockPointer,
  type IDockPointer,
  type WorldViewProjection as WorldViewProjectionName,
} from '@sdk';
import { VIEW_SLOTS, ViewSlot, ViewType, VIEWER_REGISTRY } from '../types/ViewType';
import { NavigationError, NavigationErrorType } from './NavigationError';
import { buildDockUrl, isRootAddress, parseDockUrl, parseQueryParams, rootDockAddress } from './url-builder';
import { isValidView } from './validators';
import { AssetEditor, AssetMode, AssetRoutingMethod, editorForType, LOCAL_COMPUTE_NODE } from './asset-doc-types';
import {
  assetEditorValue,
  assetWikiValue,
  normalizeAssetVfsPath,
  parseAssetWikiRef,
  serializeAssetDocPointer,
  type AssetWikiRef,
} from './asset-doc-pointer-grammar';
import {
  ALL_SCOPE_FILTER,
  dockOptionsToScopeFilter,
  pinnedProjectId,
  scopeFilterKey,
  scopeFilterToDockOptions,
  withScopeFilterOptions,
  withoutScopeFilterOptions,
  type ScopeFilter,
} from '@src/lib/scope-filter';
import { dockOptionsToSideWindows, withSideWindowsOptions, type SideWindowsState } from '@src/lib/side-windows';
import type { ViewMode } from '@src/contexts/view-mode-context';
import { DEFAULT_WORLDVIEW_COLOR_MODE, type WorldViewColorMode } from '@src/types/WorldViewColorMode';
import { DEFAULT_GRAPH_PRESENTATION, type GraphPresentation } from '@src/types/GraphPresentation';
import { credentialsPointer } from '@src/components/credentials-view/credentials-pointer';

/**
 * URL query-param key carrying the "highlight this thing" intent across the
 * app — the single source of truth for the WikiTip highlight (see
 * docs/wikitip.md). Mirrors the existing `selected` option: URL-carried so the
 * highlight is shareable + back-button-safe. Pairs with `DockPointer.highlight`
 * / `withHighlight()` (dock surfaces) and `useHighlight()` (the home root `/`,
 * which is not a dock URL).
 */
/**
 * URL query-param keys shared by the two run-history surfaces —
 * `/dock/process-runs` and the graph-workflow studio's runs panel. Kept
 * together (and used by both) so "which run is open" means one thing across
 * the app, and so a deep link can move between the scoped and unscoped views
 * without a key translation in the middle.
 */
export const RUN_PARAM = 'run';
/** Which MessageThread a conversation view is filtered to (`?thread=<id>`). */
export const THREAD_PARAM = 'thread';
export const NODE_PARAM = 'node';
export const PANEL_PARAM = 'panel';

/** The graph-workflow studio's panel tabs, as they appear in the URL. */
export type GraphWorkflowPanel = 'palette' | 'inject' | 'runs';

/**
 * How a runs list may be narrowed. These key names are the BACKEND's
 * (`flow_sdk/server/routes/runs.py:SCOPES`) verbatim — the view forwards them
 * to `GET /api/v1/runs` untranslated, so adding a scope is one entry at each
 * end and no mapping table in between.
 */
export const PROCESS_RUN_SCOPE_KEYS = [
  'project_id',
  'deployment_id',
  'flow_id',
  'flow_run_id',
  'node_id',
  'agent',
  // Paired with SCOPES in flow_sdk/server/routes/runs.py — a new scope is one
  // entry in each. An ingest worker has no spawning entity to browse from (the
  // whole reason this list exists), so its source is the only handle on it.
  'data_source_id',
] as const;

export type ProcessRunScope = Partial<Record<(typeof PROCESS_RUN_SCOPE_KEYS)[number], string>>;
export type ProcessRunsPointerOptions = ProcessRunScope & { run?: string | null };

export const HIGHLIGHT_PARAM = 'highlight';
/** A transcript entry to scroll to and select. */
export const TRANSCRIPT_ENTRY_PARAM = 'transcript_entry_id';
/** A timestamp to seek a transcript to. */
export const TRANSCRIPT_TIME_PARAM = 't';
export const VIEW_MODE_PARAM = 'viewMode';

/**
 * The agentic process whose DISPLAY is showing this dock — the vibe workspace
 * hosting it. Written by whoever opens the content (`flow show`, a click inside
 * the workspace), read by the loader to stamp `parent_tab_id`, so host identity
 * is a fact of the URL instead of something re-derived from ambient state.
 *
 * It rides in `options`, and is therefore EXCLUDED from `tabHash` for the same
 * reason `layout` and `viewMode` are: which workspace is showing a document is
 * presentation context, not the document's identity. One document is one tab
 * however many agents display it, existing rows keep their stored pointer
 * (no migration), and the backend never sees the composite form.
 *
 * Unlike the other option params it does NOT appear as a query key: the URL
 * spells it as path segments — `/dock/project/<P>/process/<typeid>/display/<tail>`
 * — which `fromUrl` lifts into this option and `toUrl` puts back. Pairs with
 * `DockPointer.hostProcessId` / `withHost()`.
 */
export const HOST_PARAM = 'host';

/** Path markers for {@link HOST_PARAM}: `<projectId>/process/<typeid>/display/<tail>`. */
const HOST_SEGMENT = 'process';
const HOST_DISPLAY_SEGMENT = 'display';

/**
 * Lift `process/<typeid>/display/` out of a PROJECT pointer, returning the
 * host-free pointer plus the host it carried. The inverse of
 * {@link embedHostInProjectPointer}. Host-free pointers pass through untouched,
 * so every existing project URL parses exactly as before.
 */
function liftHostFromProjectPointer(pointer: string | undefined): {
  pointer: string | undefined;
  hostProcessId: string | null;
} {
  if (!pointer) return { pointer, hostProcessId: null };
  const seg = pointer.split('/');
  // [0]=<projectId> [1]='process' [2]=<typeid> [3]='display' [4…]=the tail
  if (seg.length < 5 || seg[1] !== HOST_SEGMENT || seg[3] !== HOST_DISPLAY_SEGMENT) {
    return { pointer, hostProcessId: null };
  }
  return { pointer: [seg[0], ...seg.slice(4)].join('/'), hostProcessId: seg[2] || null };
}

/**
 * Put the host back into a PROJECT pointer as path segments. Returns the
 * pointer unchanged when there is no host, or when the pointer addresses the
 * project itself — a host with nothing displayed is not an address.
 */
function embedHostInProjectPointer(pointer: string | undefined, hostProcessId: string | null): string | undefined {
  if (!pointer || !hostProcessId) return pointer;
  const slash = pointer.indexOf('/');
  if (slash < 0) return pointer;
  const projectId = pointer.slice(0, slash);
  const tail = pointer.slice(slash + 1);
  if (!tail) return pointer;
  return `${projectId}/${HOST_SEGMENT}/${hostProcessId}/${HOST_DISPLAY_SEGMENT}/${tail}`;
}

/**
 * URL query-param key selecting which translated body of an asset to show. It
 * carries a language code (`es`, `he`, `fr-CA`, …); absent means the original
 * doc. Like the other option params it rides in `options` and is deliberately
 * EXCLUDED from `tabHash`, so switching languages swaps the body inline in the
 * SAME tab (no new tab). Pairs with `DockPointer.lang` / `withLang()`; the
 * asset editor reads it to point at the matching `translations[].ref`.
 */
export const LANG_PARAM = 'lang';

/**
 * URL query-param key carrying the ACTIVE USER JOURNEY across the app. Null by
 * default; when set, the guided journey tray is shown for that journey and the
 * orchestrator drives its current step. Like the other option params it rides in
 * `options` (so it is reload- and back-button-safe, and deliberately EXCLUDED
 * from `tabHash` — showing a journey never spawns a tab). It is TOPMOST/sticky:
 * `openDock` carries it onto any target that doesn't set one, so the journey
 * stays visible across navigation until explicitly closed. Pairs with
 * `DockPointer.journeyId` / `withJourney()`, `useActiveJourneyId()` (home root),
 * and `navigation.showJourney()` / `closeJourney()`.
 */
export const JOURNEY_PARAM = 'journeyId';
/**
 * Which step of that journey, 1-based. THE journey's position — there is no
 * cursor anywhere else.
 *
 * Position used to live in the journal (a `node_id` on a server row), while the
 * screen was composed by merging a partial step onto wherever the user already
 * was. Nothing in that was addressable, so nothing was reproducible: the same
 * step rendered differently depending on how you got there. A number in the URL
 * is reloadable, shareable, and the same every time.
 */
export const JOURNEY_STEP_PARAM = 'journeyStep';

/**
 * URL query-param key naming the capability the user was reaching for when they
 * were routed to the Capabilities view — e.g. clicking "Start Codex" on an
 * opener whose harness looks unavailable lands here with
 * `capability=harness.codex.cli`. The view re-probes THAT kind on arrival, so a
 * CLI installed since the last discovery sweep is found at the moment the user
 * asks for it (the sweep only runs at backend start). Absent means "no intent"
 * — the view then shows the last known state without probing anything.
 *
 * Rides in `options` (reload- and back-safe) and is excluded from `tabHash`,
 * so arriving with an intent reuses the one Capabilities tab. Pairs with
 * `DockPointer.capabilityKind` and `navigation.openTab(ViewType.CAPABILITIES,
 * { capabilityKind })`.
 */
export const CAPABILITY_PARAM = 'capability';

/**
 * Canonicalize an entity-relative path: forward slashes, collapsed separators,
 * no leading/trailing slash. Route identity itself is always carried by
 * VFSPath; this helper remains for entitySubPath and legacy-route ingestion.
 */
export function normalizeRel(path: string | null | undefined): string {
  if (!path) return '';
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export const ASSET_COMPARE_POINTER_PREFIX = 'asset-compare/';

export interface AssetComparePointerPayload {
  computeNodeId: string;
  workdir: string;
  file: string;
  assetPath: string;
  assetType: string;
  assetLabel: string;
}

function encodePointerJson(value: unknown): string {
  const json = JSON.stringify(value);
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodePointerJson<T>(value: string): T | null {
  try {
    const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
    const json = decodeURIComponent(escape(atob(padded.replace(/-/g, '+').replace(/_/g, '/'))));
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export function decodeAssetComparePointer(pointer: string | null | undefined): AssetComparePointerPayload | null {
  if (!pointer?.startsWith(ASSET_COMPARE_POINTER_PREFIX)) return null;
  return decodePointerJson<AssetComparePointerPayload>(pointer.slice(ASSET_COMPARE_POINTER_PREFIX.length));
}

function isViewMode(value: string | undefined): value is ViewMode {
  return value === 'vibe' || value === 'standard' || value === 'advanced' || value === 'dev';
}

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
  /** Which SPA-surface this dock addresses. Defaults to `desk` (today's desktop
   *  app); a sibling of `viewType`, never folded into `pointer`. */
  public readonly page: PageId;
  /** Set ONLY on a dock rebuilt from a stored Tab.pointer, where the folded
   *  sub-pointer can no longer be inspected. A live URL dock leaves this
   *  undefined and `toJSON` derives the bit from its real pointer. */
  private storedWorkspaceContent?: boolean;

  constructor(data: IDockPointer, layout?: Layout);
  constructor(viewType?: ViewType, pointer?: string, options?: Record<string, string>, layout?: Layout, page?: PageId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(viewTypeOrData?: any, pointerOrLayout?: any, options?: any, layout?: any, page?: any) {
    if (viewTypeOrData && typeof viewTypeOrData === 'object') {
      // IDockPointer overload
      this.viewType = viewTypeOrData.viewType as ViewType | undefined;
      this.pointer = viewTypeOrData.pointer;
      this.options = viewTypeOrData.options;
      this.layout = (pointerOrLayout as Layout) ?? Layout.DOCK;
      this.page = (viewTypeOrData.page as PageId | undefined) ?? PageId.DESK;
    } else {
      // Positional overload
      this.viewType = viewTypeOrData;
      this.pointer = pointerOrLayout as string | undefined;
      this.options = options;
      this.layout = layout ?? Layout.DOCK;
      this.page = (page as PageId | undefined) ?? PageId.DESK;
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
      this.page,
    );
  }

  /**
   * The project this dock pins as its active-project context (`project` scope
   * mode), or null. Reads through the scope selectors — no call site picks the
   * mode/id fields apart itself.
   */
  get scopeProjectId(): string | null {
    return pinnedProjectId(this.scopeFilter);
  }

  /**
   * Is this dock's TAB IDENTITY keyed by its scope? True for the scope-keyed
   * views (Assets, Explorer) whose `tabHash` folds every sub-pointer of one
   * scope into a single tab. Only these can be stranded by an unsatisfiable
   * scope — their tab literally cannot be minted without a live project — so
   * it's the one class of dock that needs scope repair before materialization.
   */
  get scopeKeyed(): boolean {
    return !!(this.viewType && VIEWER_REGISTRY[this.viewType]?.scopeKeyed);
  }

  /**
   * Clone this pointer with its scope removed — same surface, no scope keys.
   * The recovery for a scope that can't be satisfied (see `repairUnsatisfiableScope`
   * in main-loader): the dock keeps showing what the URL names, just unscoped,
   * instead of filtering against a project that isn't there.
   */
  withoutScopeFilter(): DockPointer {
    return new DockPointer(
      this.viewType,
      this.pointer,
      withoutScopeFilterOptions(this.options),
      this.layout,
      this.page,
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
      this.page,
    );
  }

  /**
   * The wiki word this dock asks to highlight, or null when none is set. The
   * generic accessor for highlight-in-URL on dock surfaces; the home root `/`
   * reads the same `HIGHLIGHT_PARAM` via `useHighlight()` instead (it is not a
   * dock URL). See docs/wikitip.md.
   */
  get highlight(): string | null {
    return this.options?.[HIGHLIGHT_PARAM] ?? null;
  }

  /**
   * Clone this pointer with `highlight` serialized into its options — the
   * writer that matches the `dockPointer.highlight = <wikiword>` mental model.
   * Pairs with the `highlight` getter.
   */
  /** The transcript entry this dock selects, or null. */
  get transcriptEntryId(): string | null {
    return this.options?.[TRANSCRIPT_ENTRY_PARAM] ?? null;
  }

  /** The transcript timestamp this dock seeks to, or null. */
  get transcriptTimestamp(): string | null {
    return this.options?.[TRANSCRIPT_TIME_PARAM] ?? null;
  }

  withHighlight(wikiword: string): DockPointer {
    return new DockPointer(
      this.viewType,
      this.pointer,
      { ...this.options, [HIGHLIGHT_PARAM]: wikiword },
      this.layout,
      this.page,
    );
  }

  /** Clone this dock addressing a different SPA-surface (page). */
  withPage(page: PageId): DockPointer {
    return new DockPointer(this.viewType, this.pointer, this.options, this.layout, page);
  }

  /**
   * Page-local view-mode override carried by the URL. This never represents the
   * user's persisted default; consumers combine it with PrefKey.VIEW_MODE in the
   * view-mode context.
   */
  get viewMode(): ViewMode | null {
    const value = this.options?.[VIEW_MODE_PARAM];
    return isViewMode(value) ? value : null;
  }

  /**
   * The agentic process whose display is showing this dock, or null. See
   * {@link HOST_PARAM} — this is URL-carried host identity, not a lookup.
   */
  get hostProcessId(): string | null {
    return this.options?.[HOST_PARAM] ?? null;
  }

  /** Clone this dock hosted by a process's display, or unhosted with null. */
  withHost(processId: string | null): DockPointer {
    const nextOptions = { ...(this.options ?? {}) };
    if (processId) nextOptions[HOST_PARAM] = processId;
    else delete nextOptions[HOST_PARAM];
    return new DockPointer(this.viewType, this.pointer, nextOptions, this.layout, this.page);
  }

  /** Clone this dock with a page-local view-mode override, or remove it with null. */
  withViewMode(mode: ViewMode | null): DockPointer {
    const nextOptions = { ...(this.options ?? {}) };
    if (mode) nextOptions[VIEW_MODE_PARAM] = mode;
    else delete nextOptions[VIEW_MODE_PARAM];
    return new DockPointer(this.viewType, this.pointer, nextOptions, this.layout, this.page);
  }

  /**
   * The translated-body language this dock asks to show, or null for the
   * original doc. URL-carried (shareable + back-safe) and excluded from
   * `tabHash`, so language switches stay in the same tab. Pairs with
   * `withLang()`; consumed by the markdown asset editor to swap the body ref.
   */
  get lang(): string | null {
    return this.options?.[LANG_PARAM] ?? null;
  }

  /** Clone this dock pointed at a translated body, or back to the original with null. */
  withLang(lang: string | null): DockPointer {
    return this.withOption(LANG_PARAM, lang);
  }

  /**
   * The user journey this dock is showing, or null. URL-carried (reload- and
   * back-safe) and excluded from `tabHash`, so a journey overlays the current
   * surface instead of spawning a tab. See {@link JOURNEY_PARAM}.
   */
  get journeyId(): string | null {
    return this.options?.[JOURNEY_PARAM] ?? null;
  }

  /**
   * Which step of the journey this dock is showing (1-based), or null when no
   * journey is running. See {@link JOURNEY_STEP_PARAM}.
   *
   * Returns null for anything that is not a positive integer, so a hand-edited
   * `?journeyStep=abc` reads as "no position" rather than throwing or landing
   * the tray on NaN.
   */
  get journeyStep(): number | null {
    const raw = this.options?.[JOURNEY_STEP_PARAM];
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? n : null;
  }

  /**
   * The capability kind this dock was opened FOR, or null. Set when a launch
   * surface routes to the Capabilities view because the thing the user asked
   * for looks unavailable; the view re-probes it on arrival. See
   * {@link CAPABILITY_PARAM}.
   */
  get capabilityKind(): string | null {
    return this.options?.[CAPABILITY_PARAM] ?? null;
  }

  /**
   * Clone this dock with one URL option set (or cleared with null) — the
   * generic form behind `withLang`/`withJourney` and the sticky-param
   * carry-forward in `openDock`.
   */
  withOption(key: string, value: string | null): DockPointer {
    const nextOptions = { ...(this.options ?? {}) };
    if (value) nextOptions[key] = value;
    else delete nextOptions[key];
    return new DockPointer(this.viewType, this.pointer, nextOptions, this.layout, this.page);
  }

  /** Clone this dock showing a journey, or close it (clear the param) with null. */
  withJourney(journeyId: string | null): DockPointer {
    return this.withOption(JOURNEY_PARAM, journeyId);
  }

  /** Clone this dock showing step `n` (1-based) of the running journey. */
  withJourneyStep(n: number | null): DockPointer {
    return this.withOption(JOURNEY_STEP_PARAM, n === null ? null : String(n));
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
    page?: PageId,
  ): DockPointer;
  static fromUrl(
    viewTypeOrUrl: string,
    pointer?: string,
    searchParams?: URLSearchParams,
    layout: Layout = Layout.DOCK, // Default to DOCK for backward compatibility
    page: PageId = PageId.DESK, // Default to DESK for backward compatibility
  ): DockPointer {
    if (pointer === undefined && searchParams === undefined) {
      try {
        const url = new URL(viewTypeOrUrl, 'http://flowpad.local');
        // A PATH with no layout keyword is the app root (`/`, or a base path
        // like `/agent/a/flow/f`). Gated on the leading slash so the historical
        // single-argument form — `fromUrl('editor')` — still reaches the
        // viewType parser below instead of silently resolving to the home.
        const parsedUrl = viewTypeOrUrl.startsWith('/')
          ? (parseDockUrl(url.pathname) ?? rootDockAddress(url.pathname))
          : parseDockUrl(url.pathname);
        if (parsedUrl?.viewType) {
          return DockPointer.fromUrl(
            parsedUrl.viewType,
            parsedUrl.pointer,
            url.searchParams,
            parsedUrl.layout,
            parsedUrl.page,
          );
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

    // The workspace host is spelled as PATH segments but carried as an option,
    // so it stays out of tab identity (see HOST_PARAM). Lifting here is what
    // keeps every downstream reader of a project sub-pointer — splitProjectPointer,
    // targetTypeId, the AssetsPage parsers — unaware that a host exists at all.
    if (viewType === ViewType.PROJECT) {
      const lifted = liftHostFromProjectPointer(decodedPointer);
      if (lifted.hostProcessId) {
        return new DockPointer(
          viewType as ViewType,
          lifted.pointer,
          { ...options, [HOST_PARAM]: lifted.hostProcessId },
          layout,
          page,
        );
      }
    }

    return new DockPointer(viewType as ViewType, decodedPointer, options, layout, page);
  }

  /**
   * Create dock pointer from ViewType (shortcut for tab docks)
   */
  static forTab(viewType: ViewType, options?: Record<string, string>, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(viewType, undefined, options || {}, layout);
  }

  /**
   * Live-session dock — /dock/live_session/<sessionId>. Top-level (not nested
   * under project/room) because the GUEST holds a session before any host
   * project or CollaborationRoom exists (DRAFT/PENDING states).
   */
  static forLiveSession(sessionId: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.LIVE_SESSION, sessionId, {}, layout);
  }

  /**
   * Events dock — the merged rules + activity screen. The selected rule id (and
   * the transient "creating" mode) ride in OPTIONS, never `pointer`, so the
   * tabHash stays `events|` — selection/creation are URL-addressable +
   * reload-safe but stay in ONE tab (the same rule the scope filter follows
   * here). Pair with the `trigger` / `creating` option keys read by the
   * events view and the rules navigator.
   */
  static forEvents(
    ruleId?: string,
    opts?: { creating?: string; system?: boolean; target?: string },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const options: Record<string, string> = {};
    if (ruleId) options.trigger = ruleId;
    if (opts?.creating) options.creating = opts.creating;
    // `target` narrows the feed to one subject, in the colon form a FlowEvent
    // already uses (`data_source:<id>`, `graph_workflow:<id>`, …) — so "show me
    // what this thing produced" is a link from anywhere that holds an entity,
    // not a search the user has to retype.
    if (opts?.target) options.target = opts.target;
    // `system` rides the URL rather than component state because BOTH panes
    // need it: the ScopeFilter shape is `{mode, user, projects}` and cannot
    // carry `system`, so system-scoped rules have always ridden a separate
    // toggle. Once the feed had to honour the same rule as the rules list,
    // keeping that toggle local to the navigator would have meant the body
    // silently dropping every system rule's activity.
    if (opts?.system) options.system = '1';
    return new DockPointer(ViewType.EVENTS, undefined, options, layout);
  }

  /**
   * Run history — `AgenticProcess` executions, the thing that actually runs.
   *
   * **On the name.** `runs` alone was un-namespaced, and `workflow_runs` is not
   * available: `workflow_run` is already a record type (Claude Code's
   * `wf_<runId>.json` mirror — see RECORD_TYPE_NAV), and docs/glossary.md bans
   * bare `Workflow*` for exactly that collision. This surface also lists runs
   * belonging to no flow at all — an ingest driver's worker, an agent launched
   * from its profile — so naming it after workflows would be a lie. It is
   * named for the entity it lists.
   *
   * URL shapes:
   *   /dock/process-runs                            every run
   *   /dock/process-runs?run=<processId>            one run, expanded
   *   /dock/process-runs?flow_id=…&node_id=…        narrowed
   *
   * Everything rides OPTIONS and the pointer stays empty — the same call
   * {@link forEvents} makes, and for the same reason: `tabHash` folds to
   * `process-runs|`, so selecting a run is addressable and reload-safe without
   * minting a tab per run. The scope keys are the backend's `SCOPES`
   * vocabulary verbatim, so a new scope is one entry on each side.
   */
  static forProcessRuns(opts?: ProcessRunsPointerOptions, layout: Layout = Layout.DOCK): DockPointer {
    const options: Record<string, string> = {};
    if (opts?.run) options[RUN_PARAM] = opts.run;
    for (const key of PROCESS_RUN_SCOPE_KEYS) {
      const value = opts?.[key];
      if (value) options[key] = value;
    }
    return new DockPointer(ViewType.PROCESS_RUNS, undefined, options, layout);
  }

  /** The scope this runs dock is narrowed to — `{}` when it shows everything. */
  get processRunScope(): ProcessRunScope {
    const scope: ProcessRunScope = {};
    for (const key of PROCESS_RUN_SCOPE_KEYS) {
      const value = this.options?.[key];
      if (value) scope[key] = value;
    }
    return scope;
  }

  /** The run this dock has expanded, or null. */
  get selectedRunId(): string | null {
    return this.options?.[RUN_PARAM] ?? null;
  }

  /**
   * A graph workflow's canvas — and, since the studio's own state now rides
   * the URL, which panel is open and what is selected inside it.
   *
   * URL shapes:
   *   /dock/graph-workflows                                       the list
   *   /dock/graph-workflows/graph_workflow-<id>                    the canvas
   *   /dock/graph-workflows/graph_workflow-<id>?panel=runs         its history
   *   /dock/graph-workflows/graph_workflow-<id>?panel=runs&run=<runId>
   *   /dock/graph-workflows/graph_workflow-<id>?node=<nodeId>      one station
   *
   * The flow identity is the POINTER (one tab per flow); panel/run/node are
   * OPTIONS, so `tabHash` stays `graph-workflows|graph_workflow-<id>` however
   * deep you are inside it. Before this, all three lived only in the zustand
   * studio store — a flow's run was unlinkable and did not survive a reload.
   *
   * There is deliberately NO nested `…/runs` path segment: that would key a
   * second tab off the same flow, and the flow's runs are also reachable as
   * `forProcessRuns({ flow_id })` — one list under two scopes, not two lists.
   */
  static forGraphWorkflow(
    flowId?: string | null,
    sub?: { panel?: GraphWorkflowPanel; run?: string | null; node?: string | null },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    if (!flowId) return new DockPointer(ViewType.GRAPH_WORKFLOWS, undefined, undefined, layout);
    const options: Record<string, string> = {};
    if (sub?.panel) options[PANEL_PARAM] = sub.panel;
    if (sub?.run) options[RUN_PARAM] = sub.run;
    if (sub?.node) options[NODE_PARAM] = sub.node;
    return new DockPointer(
      ViewType.GRAPH_WORKFLOWS,
      new TypeId(GraphWorkflow.type, DockPointer.tryTypeId(flowId)?.id ?? flowId).toString(),
      options,
      layout,
    );
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
   * Create dock pointer for an asset working-tree comparison.
   */
  static forAssetCompare(payload: AssetComparePointerPayload, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(
      ViewType.DIFF,
      `${ASSET_COMPARE_POINTER_PREFIX}${encodePointerJson(payload)}`,
      undefined,
      layout,
    );
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
   * Create dock pointer for the plan viewer, addressed by the **stable PLAN
   * entity id** — the canonical, process-independent form (bookmarks).
   * Reuses the asset ref grammar: `typeid/<plan-uuid>`.
   * @param planTypeId - TypeId of the PLAN entity (`plan-<uuid>`)
   */
  static forPlan(planTypeId: TypeId, layout: Layout = Layout.DOCK): DockPointer {
    const pointer = `${AssetRoutingMethod.TYPEID}/${planTypeId.toString()}`;
    return new DockPointer(ViewType.PLAN, pointer, undefined, layout);
  }

  /**
   * Create dock pointer for the plan viewer, addressed by **VFS path** — the
   * race-free form for the live "open plan" button (no dependency on the
   * fs-records scanner having minted the PLAN entity yet). The explicit `vfs`
   * method segment means the path can never be mistaken for a TypeId, so there
   * is no embedded-`//` hazard. `vfs/<compute_node-id>/<relPath>`.
   * @param absPath - Absolute machine path to the plan .md file
   * @param computeNode - Compute node the file lives on (default: local @local)
   */
  static forPlanByPath(
    absPath: string,
    computeNode: TypeId = LOCAL_COMPUTE_NODE,
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const absVfs = VFSPath.fromMachinePath(absPath, computeNode).absVfsPath;
    const pointer = `${AssetRoutingMethod.VFS}/${absVfs}`;
    return new DockPointer(ViewType.PLAN, pointer, undefined, layout);
  }

  /**
   * Parse a plan pointer into its addressing method. Pure/sync — no network,
   * no `new TypeId` on a vfs value. Three shapes:
   *   - `typeid/<plan-uuid>`              → `{ kind: 'typeid', planTypeId }`
   *   - `vfs/<compute_node-id>/<relPath>` → `{ kind: 'vfs', vfsValue }`
   *   - `agentic_process-<id>/<path>`     → `{ kind: 'legacy', ... }` (old form;
   *     the loader resolves + redirects it to the canonical `vfs` form)
   * Returns null on anything else.
   */
  static parsePlanPointer(
    pointer: string,
  ):
    | { kind: 'typeid'; planTypeId: TypeId }
    | { kind: 'vfs'; vfsValue: string }
    | { kind: 'legacy'; agenticProcessTypeId: TypeId; filePath: string }
    | null {
    if (!pointer) return null;
    const firstSlash = pointer.indexOf('/');
    if (firstSlash < 0) return null;
    const method = pointer.slice(0, firstSlash);
    const value = pointer.slice(firstSlash + 1);
    if (!value) return null;
    // Legacy form: "agentic_process-<uuid>/<absolute-file-path-without-leading-slash>".
    // Here `method` is the whole "agentic_process-<uuid>" typeid and `value` the rel path.
    if (DockPointer.isAgenticProcessPointer(pointer)) {
      return { kind: 'legacy', agenticProcessTypeId: new TypeId(method), filePath: `/${value}` };
    }
    if (method === String(AssetRoutingMethod.TYPEID)) {
      return { kind: 'typeid', planTypeId: new TypeId(value) };
    }
    if (method === String(AssetRoutingMethod.VFS)) {
      return { kind: 'vfs', vfsValue: value };
    }
    return null;
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
    const path = normalizeAssetVfsPath(vfsPath);
    return new DockPointer(
      ViewType.ASSETS,
      serializeAssetDocPointer({
        mode: AssetMode.EDITOR,
        value: path.absVfsPath,
        editor,
        method: AssetRoutingMethod.VFS,
      }),
      options,
      layout,
    );
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
    return new DockPointer(
      ViewType.ASSETS,
      serializeAssetDocPointer({
        mode: AssetMode.EDITOR,
        value: typeId.toString(),
        editor,
        method: AssetRoutingMethod.TYPEID,
      }),
      options,
      layout,
    );
  }

  /**
   * Create dock pointer for a wiki link by name. Resolves to a markdown record
   * at view time; the URL stays at the name form (rename-resilient).
   * Pointer format: "wiki/<encoded name>"
   * URL: /dock/assets/wiki/<encoded name>
   */
  static forWiki(name: string, layout: Layout = Layout.DOCK, space?: string, fragment?: string): DockPointer {
    // Canonical grammar: wiki/<space>/<name> (space default @local). An optional
    // `fragment` deep-links to a heading; it rides as a query param, not the path.
    const options = fragment ? { wikiFragment: fragment } : undefined;
    return new DockPointer(
      ViewType.ASSETS,
      serializeAssetDocPointer({
        mode: AssetMode.WIKI,
        value: assetWikiValue(name, space),
      }),
      options,
      layout,
    );
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
   * Create a pointer for the project landing rendered inside the project-scoped
   * Assets tab. Assets is scope-keyed, so this shares the same tab as the asset
   * manager for that project while still giving the landing a restorable URL.
   */
  static forAssetProjectHome(options?: { scope?: ScopeFilter }, layout: Layout = Layout.DOCK): DockPointer {
    const base = new DockPointer(ViewType.ASSETS, AssetMode.PROJECT_HOME, undefined, layout);
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
    const pointer = cleanRel ? `folder/${typeName}/${typeid}/${cleanRel}` : `folder/${typeName}/${typeid}`;
    return new DockPointer(ViewType.ASSETS, pointer, undefined, layout);
  }

  /**
   * Create a filesystem-browser pointer from canonical VFS identity.
   *
   * Route grammar: `fs/vfs/<absVfsPath>`. `vfs://` is deliberately not placed
   * in the path segments; `VFSPath.absVfsPath` is the route-safe serialization.
   */
  static forAssetFs(vfsPath: VFSPath, layout: Layout = Layout.DOCK): DockPointer {
    if (!vfsPath.isAbsolute) {
      throw new Error(`Asset filesystem pointers require an absolute VFS path: "${vfsPath.rawPath}"`);
    }
    return new DockPointer(ViewType.ASSETS, `fs/${AssetRoutingMethod.VFS}/${vfsPath.absVfsPath}`, undefined, layout);
  }

  /**
   * Transitional source-compatible builder. New callers should construct a
   * VFSPath explicitly and use `forAssetFs`; relative and machine paths here
   * resolve against the canonical local locator (`compute_node-@local`).
   *
   * @deprecated use `forAssetFs(VFSPath)`
   */
  static forAssetFsFolder(path: string, layout: Layout = Layout.DOCK): DockPointer {
    const parsed = VFSPath.parse(path);
    const vfsPath = parsed.isAbsolute
      ? parsed
      : path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path)
        ? VFSPath.fromMachinePath(path, LOCAL_COMPUTE_NODE)
        : VFSPath.fromTypeId(LOCAL_COMPUTE_NODE, normalizeRel(path));
    return DockPointer.forAssetFs(vfsPath, layout);
  }

  /** Parse the canonical `fs/vfs/<absVfsPath>` assets route. */
  static parseAssetFsPointer(pointer: string | undefined | null): VFSPath | null {
    const prefix = `fs/${AssetRoutingMethod.VFS}/`;
    if (!pointer?.startsWith(prefix)) return null;
    const parsed = VFSPath.parse(pointer.slice(prefix.length));
    return parsed.isAbsolute ? parsed : null;
  }

  /**
   * Return the canonical replacement for a legacy `fs/<relative>` route.
   * Legacy fs routes could only address this machine, so the durable locator is
   * `compute_node-@local`; live UUIDs remain an I/O concern.
   */
  canonicalLegacyAssetFsDock(): DockPointer | null {
    const assetsPointer = this.viewType === ViewType.ASSETS ? (this.pointer ?? null) : this.assetSubPointer;
    const canonicalPrefix = `fs/${AssetRoutingMethod.VFS}/`;
    if (!assetsPointer?.startsWith('fs/') || assetsPointer.startsWith(canonicalPrefix)) {
      return null;
    }

    const relativePath = normalizeRel(assetsPointer.slice('fs/'.length));
    const canonical = DockPointer.forAssetFs(VFSPath.fromTypeId(LOCAL_COMPUTE_NODE, relativePath), this.layout);
    const rebased =
      this.viewType === ViewType.PROJECT
        ? DockPointer.rebaseAssetsOntoProject(canonical, DockPointer.splitProjectPointer(this.pointer).projectId)
        : canonical;
    return new DockPointer(rebased.viewType, rebased.pointer, this.options, this.layout, this.page);
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
   * Create dock pointer for a project's collaboration view, optionally with
   * an active collaboration_room and/or an active tab inside that room, or
   * a focused conversation.
   *
   * URL formats:
   *   /dock/project/<projectId>
   *   /dock/project/<projectId>/collaboration_room/<roomId>
   *   /dock/project/<projectId>/collaboration_room/<roomId>/tab/<typeid>
   *   /dock/project/<projectId>/collaboration_room/<roomId>/session/<sessionId>
   *   /dock/project/<projectId>/conversation/<conversationId>
   *
   * `typeid` is the standard TypeId string (e.g. "agentic_process-<uuid>").
   *
   * Precedence: when both `roomId` and `conversationId` are passed, `conversationId`
   * wins — the room shape is dropped to keep the URL unambiguous. Within a room,
   * `sessionId` (the active shared session) takes precedence over `tab`.
   */
  static forProject(
    projectId?: string,
    sub?: { roomId?: string | null; tab?: TypeId | null; conversationId?: string | null; sessionId?: string | null },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    if (!projectId) return new DockPointer(ViewType.PROJECT, undefined, undefined, layout);
    const segments: string[] = [projectId];
    if (sub?.conversationId) {
      segments.push('conversation', sub.conversationId);
    } else if (sub?.roomId) {
      segments.push('collaboration_room', sub.roomId);
      if (sub.sessionId) {
        segments.push('session', sub.sessionId);
      } else if (sub.tab) {
        segments.push('tab', sub.tab.toString());
      }
    }
    return new DockPointer(ViewType.PROJECT, segments.join('/'), undefined, layout);
  }

  /**
   * The helpdesk portal for `projectId`, optionally showing one guide.
   *
   * URL shapes:
   *   /dock/helpdesk/<projectId>
   *   /dock/helpdesk/<projectId>/article/<repo-relative path>
   *
   * `articlePath` keeps its slashes — `buildDockUrl` encodes segments
   * individually, and `parseHelpdeskPointer` re-joins the tail, so
   * `docs/Getting Started/Welcome.md` survives the round trip intact.
   */
  static forHelpdesk(projectId?: string, articlePath?: string | null, layout: Layout = Layout.DOCK): DockPointer {
    if (!projectId) return new DockPointer(ViewType.HELPDESK, undefined, undefined, layout);
    const pointer = articlePath ? `${projectId}/article/${articlePath}` : projectId;
    return new DockPointer(ViewType.HELPDESK, pointer, undefined, layout);
  }

  /**
   * Parse a helpdesk pointer. Returns nulls for anything absent or malformed —
   * never throws, so a hand-edited URL renders the portal root rather than
   * blowing up the shell.
   */
  static parseHelpdeskPointer(pointer?: string | null): {
    projectId: string | null;
    articlePath: string | null;
  } {
    const segments = (pointer ?? '').split('/').filter(Boolean);
    if (segments.length === 0) return { projectId: null, articlePath: null };
    const [projectId, marker, ...rest] = segments;
    const articlePath = marker === 'article' && rest.length ? rest.join('/') : null;
    return { projectId, articlePath };
  }

  /**
   * Parse a project pointer string.
   *
   * Accepted shapes:
   *   <projectId>
   *   <projectId>/collaboration_room/<roomId>
   *   <projectId>/collaboration_room/<roomId>/tab/<type>-<id>
   *   <projectId>/collaboration_room/<roomId>/session/<sessionId>
   *   <projectId>/conversation/<conversationId>
   *
   * Returns nulls for segments that aren't present or the input is malformed.
   */
  static parseProjectPointer(pointer: string | undefined | null): {
    projectTypeId: TypeId | null;
    roomId: string | null;
    tabTypeId: TypeId | null;
    sessionId: string | null;
    conversationId: string | null;
  } {
    if (!pointer) return { projectTypeId: null, roomId: null, tabTypeId: null, sessionId: null, conversationId: null };
    const parts = pointer.split('/').filter(Boolean);
    // parts[0] identifies the project. It may arrive bare (`<id>`) or as a
    // serialized `<type>-<id>` typeid — route it through TypeId so the type
    // token is parsed by the one object that owns that grammar, never
    // string-matched / prefix-stripped here.
    const projectTypeId = parts[0] ? DockPointer.projectSegmentToTypeId(parts[0]) : null;
    let roomId: string | null = null;
    let tabTypeId: TypeId | null = null;
    let sessionId: string | null = null;
    let conversationId: string | null = null;
    if (parts[1] === 'conversation' && parts[2]) {
      conversationId = parts[2];
    } else if (parts[1] === 'collaboration_room' && parts[2]) {
      roomId = parts[2];
      if (parts[3] === 'session' && parts[4]) {
        sessionId = parts[4];
      } else if (parts[3] === 'tab' && parts[4]) {
        try {
          tabTypeId = new TypeId(parts[4]);
        } catch {
          tabTypeId = null;
        }
      }
    }
    return { projectTypeId, roomId, tabTypeId, sessionId, conversationId };
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
  static splitProjectPointer(pointer: string | undefined | null): {
    projectId: string | null;
    assetSubPointer: string;
  } {
    if (!pointer) return { projectId: null, assetSubPointer: '' };
    const slash = pointer.indexOf('/');
    if (slash < 0) return { projectId: pointer, assetSubPointer: '' };
    const assetSubPointer = pointer.slice(slash + 1);
    // Tripwire. The host is lifted out of the pointer in `fromUrl` and only put
    // back when serializing, so a `process/` prefix here means a stored pointer
    // or a hand-built dock kept the composite form. Left alone it degrades
    // silently — `AssetDocPointer.parse` throws `unknown mode "process"`,
    // `loadAssetRoute` swallows it with a console.warn, and the user gets a
    // blank pane. Fail loudly at the one chokepoint every consumer shares.
    if (assetSubPointer.startsWith(`${HOST_SEGMENT}/`)) {
      throw new NavigationError(
        NavigationErrorType.INVALID_POINTER,
        `Project pointer still carries its workspace host: ${pointer}. ` +
          'Build it through DockPointer.fromUrl/withHost so the host rides in options.',
      );
    }
    return {
      projectId: pointer.slice(0, slash),
      assetSubPointer,
    };
  }

  /**
   * Rebase a `ViewType.ASSETS` pointer onto `/dock/project/<projectId>` so
   * navigation initiated by an assets-shaped builder (`forAssetEditor`,
   * `forAssetFolder`, `forAssetList`, `forAssetWiki`) stays inside the project
   * shell. Non-ASSETS pointers and falsy `projectId` pass through unchanged —
   * call sites can use this unconditionally.
   */
  static rebaseAssetsOntoProject(p: DockPointer, projectId: string | null | undefined): DockPointer {
    if (!projectId || p.viewType !== ViewType.ASSETS) return p;
    const sub = p.pointer ? `${projectId}/${p.pointer}` : projectId;
    return new DockPointer(ViewType.PROJECT, sub, p.options, p.layout, p.page);
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
    return new DockPointer(
      ViewType.INBOX,
      undefined,
      Object.keys(queryOptions).length ? queryOptions : undefined,
      layout,
    );
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
   * THE app root — the desk home, spelled `/`.
   *
   * An ordinary location: the desk `HOME` view with no pointer. It used to be
   * the ABSENCE of a pointer (`currentDock === null`), which left every caller
   * that had to work "dock or home" holding a raw URL string. Compose on it like
   * any other pointer: `DockPointer.root().withJourney(id)`.
   *
   * Not a tab — HOME is `chrome: 'fullbleed'`, so `tabHash` is null.
   */
  static root(): DockPointer {
    return new DockPointer(ViewType.HOME);
  }

  /** True when this pointer IS the app root (see `isRootAddress`). */
  get isRoot(): boolean {
    return isRootAddress(this.viewType, this.pointer, this.layout, this.page);
  }

  /** This pointer carrying the query options of `url`. The root has no path of
   *  its own to parse, so its options have to be lifted across explicitly. */
  withOptionsFromUrl(url: string): DockPointer {
    const query = new URL(url, 'http://flowpad.local').searchParams;
    return new DockPointer(this.viewType, this.pointer, parseQueryParams(query), this.layout, this.page);
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
    options?: { scope?: string; project?: string; expand?: boolean; vibeNoProcess?: boolean },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const queryOptions: Record<string, string> = {};
    if (item) queryOptions.item = item;
    if (options?.scope && options.scope !== 'all') queryOptions.scope = options.scope;
    if (options?.project) queryOptions.project = options.project;
    if (options?.expand) queryOptions.expand = 'true';
    if (options?.vibeNoProcess) queryOptions.vibeNoProcess = 'true';
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
    options?: { depth?: number; selected?: string; hidden?: readonly string[]; query?: string },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const pointer = typeId ? `${typeId.type}/${typeId.id}` : undefined;
    const queryOptions: Record<string, string> = {};
    if (options?.depth) queryOptions.depth = String(options.depth);
    if (options?.selected) queryOptions.selected = options.selected;
    const hidden = [...new Set(options?.hidden ?? [])].filter(Boolean).sort();
    if (hidden.length) queryOptions.hide = hidden.join(',');
    if (options?.query) queryOptions.q = options.query;
    return new DockPointer(
      ViewType.GRAPH,
      pointer,
      Object.keys(queryOptions).length ? queryOptions : undefined,
      layout,
    );
  }

  /** Create one projection-first WorldView URL with all in-view state in query options. */
  static forWorldView(
    projection: WorldViewProjectionName = WorldViewProjection.DEPLOYMENT,
    options?: {
      focus?: TypeId | string | null;
      depth?: number;
      selected?: string;
      signal?: WorldViewColorMode;
      /** Renderer choice — serialized as `?render=` (see GraphPresentation). */
      render?: GraphPresentation;
      hidden?: readonly string[];
      query?: string;
    },
    layout: Layout = Layout.DOCK,
    page: PageId = projection === WorldViewProjection.DEPLOYMENT ? PageId.DESK : PageId.HUB,
  ): DockPointer {
    const queryOptions: Record<string, string> = {};
    const focus = typeof options?.focus === 'string' ? options.focus : options?.focus?.toString();
    if (focus) queryOptions.focus = focus;
    if (options?.depth) queryOptions.depth = String(options.depth);
    if (options?.selected) queryOptions.selected = options.selected;
    if (
      projection === WorldViewProjection.DEPLOYMENT &&
      options?.signal &&
      options.signal !== DEFAULT_WORLDVIEW_COLOR_MODE
    ) {
      queryOptions.signal = options.signal;
    }
    if (options?.render && options.render !== DEFAULT_GRAPH_PRESENTATION) queryOptions.render = options.render;
    const hidden = [...new Set(options?.hidden ?? [])].filter(Boolean).sort();
    if (hidden.length) queryOptions.hide = hidden.join(',');
    if (options?.query) queryOptions.q = options.query;
    return new DockPointer(
      ViewType.WORLDVIEW,
      projection,
      Object.keys(queryOptions).length ? queryOptions : undefined,
      layout,
      page,
    );
  }

  /** Shared query-option assembly for the subgraph-surface pointers. */
  private static subgraphOptions(options?: {
    depth?: number;
    /** Omit `depth` when it equals this (URL hygiene, one rule for every
     *  subgraph-surface pointer). */
    defaultDepth?: number;
    selected?: string;
    render?: GraphPresentation;
    hidden?: readonly string[];
    query?: string;
    carry?: Record<string, string>;
  }): Record<string, string> | undefined {
    const queryOptions: Record<string, string> = { ...(options?.carry ?? {}) };
    if (options?.render && options.render !== DEFAULT_GRAPH_PRESENTATION) queryOptions.render = options.render;
    if (options?.depth && options.depth !== options.defaultDepth) queryOptions.depth = String(options.depth);
    if (options?.selected) queryOptions.selected = options.selected;
    const hidden = [...new Set(options?.hidden ?? [])].filter(Boolean).sort();
    if (hidden.length) queryOptions.hide = hidden.join(',');
    if (options?.query) queryOptions.q = options.query;
    return Object.keys(queryOptions).length ? queryOptions : undefined;
  }

  /**
   * Tag graph/tree at `/dock/tag/graph[/<name>]` — <name> is a dot-path
   * TAG NAME (not a typeid; ghost tags are first-class). Focus lives in
   * the pointer (dependency pattern); `view=tree` and friends ride options.
   */
  static forTagGraph(
    tag?: string | null,
    options?: {
      /** Data shape owned by this surface (`?view=tree` = ontology tree). */
      view?: 'tree';
      depth?: number;
      selected?: string;
      render?: GraphPresentation;
      hidden?: readonly string[];
      query?: string;
      carry?: Record<string, string>;
    },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const pointer = tag ? `graph/${encodeURIComponent(tag)}` : 'graph';
    const carry = { ...(options?.carry ?? {}) };
    if (options?.view) carry.view = options.view;
    return new DockPointer(ViewType.TAG, pointer, DockPointer.subgraphOptions({ ...options, carry }), layout);
  }

  /** Split a TAG pointer: `graph[/<name>]` → `{ sub: 'graph', tag }`. */
  static parseTagPointer(pointer: string | undefined): { sub: string; tag: string | null } | null {
    if (!pointer) return null;
    const idx = pointer.indexOf('/');
    const sub = idx < 0 ? pointer : pointer.slice(0, idx);
    if (sub !== 'graph') return null;
    const tag = idx < 0 ? null : pointer.slice(idx + 1);
    return { sub, tag: tag ? DockPointer.tryDecode(tag) : null };
  }

  /** Best-effort decode for pointer segments encoded by the `for*` factories. */
  private static tryDecode(segment: string): string {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }

  /**
   * Generic entity-subgraph at `/dock/subgraph/<projection>[/<focusKey>]` —
   * layer 2's zero-new-frontend-code path. The focus segment is a node key.
   */
  static forSubgraph(
    projection: string,
    focusKey?: string | null,
    options?: {
      depth?: number;
      selected?: string;
      render?: GraphPresentation;
      hidden?: readonly string[];
      query?: string;
      carry?: Record<string, string>;
    },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const pointer = focusKey ? `${projection}/${encodeURIComponent(focusKey)}` : projection;
    return new DockPointer(ViewType.SUBGRAPH, pointer, DockPointer.subgraphOptions(options), layout);
  }

  /** Split a SUBGRAPH pointer into `{ projection, focus }`. */
  static parseSubgraphPointer(pointer: string | undefined): { projection: string; focus: string | null } | null {
    if (!pointer) return null;
    const idx = pointer.indexOf('/');
    if (idx < 0) return { projection: pointer, focus: null };
    const projection = pointer.slice(0, idx);
    if (!projection) return null;
    const focus = pointer.slice(idx + 1);
    return { projection, focus: focus ? DockPointer.tryDecode(focus) : null };
  }

  /**
   * Create a DockPointer for the frozen-context viewer at
   * `/dock/graph_context/<id>`. `id` is the GraphContext entity's UUID.
   */
  static forGraphContext(id: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.GRAPH_CONTEXT, id, undefined, layout);
  }

  /**
   * Create a DockPointer for the diagnosis viewer at `/dock/diagnosis/<id>`.
   * `id` is the FlowpadDiagnosis entity's UUID.
   */
  static forDiagnosis(id: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.DIAGNOSIS, id, undefined, layout);
  }

  /** Split a GRAPH pointer into its `{ type, id }` parts. */
  static parseGraphPointer(pointer: string | undefined): { type: string; id: string } | null {
    if (!pointer) return null;
    const parts = pointer.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    return { type: parts[0], id: parts[1] };
  }

  /** Parse one of the three canonical projection pointer values. */
  static parseWorldViewProjection(pointer: string | undefined): WorldViewProjectionName | null {
    return isWorldViewProjection(pointer) ? pointer : null;
  }

  /** Split a retired entity-rooted WORLDVIEW pointer for redirect compatibility. */
  static parseWorldViewPointer(pointer: string | undefined): { type: string; id: string } | null {
    return DockPointer.parseGraphPointer(pointer);
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
    const cleanValue = method === 'vfs' && value.startsWith('/') ? value.slice(1) : value;
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
  static parseKnowledgeBrowserPointer(pointer: string | undefined): { method: 'vfs' | 'typeid'; value: string } | null {
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
  static forTasks(taskId?: string, options?: { conversationId?: string; layout?: Layout }): DockPointer {
    // Task is now a generic folder asset — it opens through the shared asset
    // editor (`editor/task/typeid/task-<id>`), not a bespoke ViewType.TASKS.
    // Delegating here transparently repoints every `forTasks` caller.
    const layout = options?.layout ?? Layout.DOCK;
    if (!taskId) return DockPointer.forAssetList('task', undefined, layout);
    const opts = options?.conversationId ? { conversationId: options.conversationId } : undefined;
    return DockPointer.forAssetEditorByTypeId('task', new TypeId('task', taskId), layout, opts);
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
    sub?: { messageId?: string | null; thread?: string | null },
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    const pointer = sub?.messageId ? `${conversationId}/message/${sub.messageId}` : conversationId;
    // `thread` rides OPTIONS, not the path: opening a thread is a filter over
    // the same conversation, so `tabHash` must stay `conversation|<id>` and
    // never mint a second tab. Same call `forEvents` and `forProcessRuns`
    // make, for the same reason.
    const options: Record<string, string> = {};
    if (sub?.thread) options[THREAD_PARAM] = sub.thread;
    return new DockPointer(ViewType.CONVERSATION, pointer, options, layout);
  }

  /** The thread this conversation dock is filtered to, or null for all. */
  get threadId(): string | null {
    return this.options?.[THREAD_PARAM] ?? null;
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
  static parseConversationPointer(pointer: string | undefined | null): {
    conversationId: string | null;
    messageId: string | null;
  } {
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
    filters?: {
      record_type?: string;
      status?: string;
      scope?: string;
      time_preset?: string;
      time_start?: string;
      time_end?: string;
    },
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
    workerType: 'claude' | 'codex' | 'copilot' | 'workflow',
    ref: string,
    layout: Layout = Layout.DOCK,
    options?: Record<string, string>,
  ): DockPointer {
    // Uniform across workers: encode. Claude used to be exempt so its legacy
    // two-segment ref (`<projectEncodedName>/<sessionId>`) kept its slash, but
    // nothing constructs that shape any more — claude now emits the same two
    // forms as codex/copilot (bare session id, or an absolute transcript path),
    // and encoding a bare UUID is a no-op. LensViewer still PARSES the legacy
    // form for old bookmarks.
    return DockPointer.forLens(workerType, 'transcript', encodeURIComponent(ref), layout, options);
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
   * Create dock pointer for the user Preferences screen.
   * @param category - Optional category whose tab should be active
   */
  static forPreferences(category?: string, layout: Layout = Layout.DOCK): DockPointer {
    return new DockPointer(ViewType.PREFERENCES, category, {}, layout);
  }

  /**
   * Create dock pointer for the Credentials screen.
   *
   * The pointer grammar (`<subview>[/<projectId>]`) is not restated here —
   * `credentialsPointer` owns it, so a change there reaches every caller.
   * @param tab - Which tab is active; omitted lands on the caller's leading tab
   * @param projectId - Project whose environment is shown (Environment tab)
   */
  static forCredentials(
    tab: CredentialsSubview = CredentialsSubview.CONNECTIONS,
    projectId?: string,
    layout: Layout = Layout.DOCK,
  ): DockPointer {
    return new DockPointer(ViewType.CREDENTIALS, credentialsPointer(tab, projectId), {}, layout);
  }

  /**
   * Check equality with another dock pointer
   */
  equals(other: DockPointer): boolean {
    return (
      this.viewType === other.viewType &&
      this.pointer === other.pointer &&
      this.page === other.page &&
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
    // Page namespaces tab identity: `desk` (the default) stays UNPREFIXED so every
    // existing persisted `Tab.pointer` key is byte-identical (no migration); a
    // non-desk page prefixes its id, giving each page its own tab namespace so a
    // `desk` tab and a `hub` tab with the same viewType/pointer never collide.
    const pagePrefix = this.page === PageId.DESK ? '' : `${this.page}|`;
    // A scope-keyed view (Assets, Explorer) is a SINGLE tab per scope: every
    // sub-pointer (asset type/folder/editor, explorer folder) of one scope folds
    // into ONE tab. Identity = the scope filter (global when unset), NOT the
    // sub-pointer. scopeFilterKey: 'all' | 'user' | 'project:<id>' |
    // 'filter:<0|1>:p1,p2'.
    if (VIEWER_REGISTRY[this.viewType]?.scopeKeyed) {
      return `${pagePrefix}${this.viewType}|${scopeFilterKey(this.scopeFilter ?? ALL_SCOPE_FILTER)}`;
    }
    // Pointer-folding views (e.g. Preferences) collapse all their category/field
    // sub-pointers into ONE tab: identity is the viewType, pointer dropped. The
    // flag lives in VIEWER_REGISTRY so this stays declarative (cf. the fullbleed
    // check above) instead of hardcoding viewTypes here.
    if (VIEWER_REGISTRY[this.viewType]?.foldsPointer) {
      return `${pagePrefix}${this.viewType}|`;
    }
    return `${pagePrefix}${this.viewType}|${this.pointer ?? ''}`;
  }

  /** Serialize this dock's tab-identity fields (viewType + pointer) as JSON.
   *  This is what Tab.pointer stores in the DB. Returns null if tabHash is null. */
  toJSON(): string | null {
    if (!this.tabHash) return null;
    // Scope-keyed identity is the SCOPE, not the sub-pointer. Normalize the pointer to
    // '' and persist the scope (options) + the computed tabHash so: (a) the stored
    // JSON is constant for a given scope regardless of which type was last viewed
    // → the backend mints ONE Tab row per scope; (b) `Tab.dockPointer` rebuilds the
    // same tabHash directly from the stored field; (c) clicking the chip reopens the
    // scoped browser root. Preserve only whether the live Assets URL addresses
    // content: the backend needs that URL-owned fact to validate a workspace
    // parent edge after the sub-pointer itself is folded out of tab identity.
    // It does not change tabHash, so editor/list URLs still share one row.
    if (VIEWER_REGISTRY[this.viewType]?.scopeKeyed) {
      // A dock rebuilt from stored JSON has already had its sub-pointer folded
      // to '' (and `fromUrl` supplied a default), so re-deriving the bit there
      // would invent one. Trust what was stored; derive only for a live URL.
      const workspaceContent =
        this.storedWorkspaceContent ??
        (this.viewType === ViewType.ASSETS &&
          (this.pointer?.startsWith(`${AssetMode.EDITOR}/`) || this.pointer?.startsWith(`${AssetMode.WIKI}/`)));
      return JSON.stringify({
        viewType: this.viewType,
        pointer: '',
        options: this.scopeFilter ? scopeFilterToDockOptions(this.scopeFilter) : undefined,
        tabHash: this.tabHash,
        workspaceContent: workspaceContent || undefined,
      });
    }
    // Pointer-folding views (Preferences, …) persist a constant identity: pointer
    // normalized to '' so the backend mints ONE Tab row regardless of which
    // category was last viewed (same intent as the ASSETS scope-folding above).
    if (VIEWER_REGISTRY[this.viewType]?.foldsPointer) {
      return JSON.stringify({ viewType: this.viewType, pointer: '' });
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
        workspaceContent?: boolean;
      };
      const { viewType, pointer, options } = parsed;
      if (!viewType) return null;
      const normalized = normalizeWorldViewDockPointer(
        normalizeRetiredDockPointer({
          viewType: viewType as ViewType,
          pointer,
          options,
        }),
      );
      const dp = DockPointer.fromUrl(
        normalized.viewType ?? viewType,
        normalized.pointer || undefined,
        undefined,
        Layout.DOCK,
        normalized.page ?? PageId.DESK,
      );
      // Restore scope options (assets identity) so the reconstructed dock's
      // tabHash matches the live nav dock's.
      const restored = normalized.options
        ? new DockPointer(dp.viewType, dp.pointer, normalized.options, dp.layout, dp.page)
        : dp;
      // Carry the stored bit verbatim — absent means false, not "unknown", so a
      // toJSON → fromJSON → toJSON round trip is stable.
      restored.storedWorkspaceContent = parsed.workspaceContent === true;
      return restored;
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
    if (this.viewType === ViewType.WORLDVIEW) {
      const focus = this.options?.focus ?? null;
      const separator = focus?.indexOf(TypeId.DELIMITER) ?? -1;
      return separator > 0
        ? DockPointer.tryTypeId(focus!.slice(0, separator), focus!.slice(separator + TypeId.DELIMITER.length))
        : null;
    }
    if (this.viewType === ViewType.GRAPH) {
      const parsed = DockPointer.parseGraphPointer(pointer);
      return parsed ? DockPointer.tryTypeId(parsed.type, parsed.id) : null;
    }
    // A PLAN dock addresses its PLAN entity directly in the `typeid/<plan-id>`
    // form; the `vfs/<path>` form is path-resolved and carries no typeid target.
    if (this.viewType === ViewType.PLAN) {
      const parsed = DockPointer.parsePlanPointer(pointer);
      return parsed?.kind === 'typeid' ? parsed.planTypeId : null;
    }
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
    // A live-session dock targets its RemoteWorkerSession entity (id = session
    // id). The viewType STRING ('live_session') differs from the entity TYPE
    // ('remote_worker_session'), so it must be surfaced explicitly — the generic
    // fallback below would mint the tab against a non-existent 'live_session'
    // target, leaving it untitled and projectless (Global-scoped). Puts the
    // session on the same entity rail as every other tab: the mint resolves its
    // title (host/guest) and the loader its project.
    if (this.viewType === ViewType.LIVE_SESSION) {
      return DockPointer.tryTypeId(RemoteWorkerSession.type, pointer);
    }
    // A helpdesk dock targets the portal PROJECT it renders. Same reason as
    // live_session above: the viewType string ('helpdesk') is not an entity
    // type, so the generic fallback would mint the tab against a non-existent
    // 'helpdesk' target — untitled and projectless. The article sub-pointer is
    // deliberately dropped: every article belongs to the one portal project, so
    // the tab stays on the portal (see `foldsPointer` in the viewer registry).
    if (this.viewType === ViewType.HELPDESK) {
      const { projectId } = DockPointer.parseHelpdeskPointer(pointer);
      return projectId ? DockPointer.tryTypeId(Project.type, projectId) : null;
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
    const candidate = pointer.includes('/typeid/') ? (pointer.split('/typeid/').pop() ?? '') : pointer;
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
    return assetEditorValue(pointer, method);
  }

  /**
   * Canonical filesystem identity addressed by this route, independent of the
   * view that renders it. Pure string parsing; no network or request context.
   *
   * Supported route families:
   * - Assets editor: `editor/<editor>/vfs/<absVfsPath>`
   * - Assets files:  `fs/vfs/<absVfsPath>`
   * - project-rebased variants of both
   * - Explorer: `<absVfsPath>`
   * - Plan: `vfs/<absVfsPath>`
   * - raw editor when its pointer already carries an absolute VFS path
   */
  get resourceVfsPath(): VFSPath | null {
    const assetsPointer = this.viewType === ViewType.ASSETS ? (this.pointer ?? null) : this.assetSubPointer;
    if (assetsPointer) {
      const fsPath = DockPointer.parseAssetFsPointer(assetsPointer);
      if (fsPath) return fsPath;

      const editorValue = this.assetEditorValue(assetsPointer, AssetRoutingMethod.VFS);
      if (editorValue) {
        const parsed = VFSPath.parse(editorValue);
        return parsed.isAbsolute ? parsed : null;
      }
    }

    if (this.viewType === ViewType.PLAN && this.pointer) {
      const plan = DockPointer.parsePlanPointer(this.pointer);
      if (plan?.kind === 'vfs') {
        const parsed = VFSPath.parse(plan.vfsValue);
        return parsed.isAbsolute ? parsed : null;
      }
    }

    if ((this.viewType === ViewType.EXPLORER || this.viewType === ViewType.EDITOR) && this.pointer) {
      const parsed = VFSPath.parse(this.pointer);
      return parsed.isAbsolute ? parsed : null;
    }

    return null;
  }

  /**
   * @deprecated use `resourceVfsPath`, whose name reflects that VFS identity is
   * shared across editor, Files, Explorer, and Plan route grammars.
   */
  get vfsPath(): VFSPath | null {
    return this.resourceVfsPath;
  }

  /**
   * The wiki space + word this route addresses, for a `wiki/…` dock.
   *
   * The THIRD addressing form, alongside `targetTypeId` and `resourceVfsPath`,
   * and the only one that names its subject rather than identifying it: a wiki
   * route stays at the word so it survives a rename, which is exactly why the
   * other two return null here. Anything that wants to say where a wiki route
   * points reads this — the word is a usable label with no lookup at all, and
   * the space is the Wiki entity's own id.
   *
   * Covers the project-rebased form (`/dock/project/<id>/wiki/…`) through the
   * same `assetSubPointer` un-rebase the other two getters use.
   */
  get wikiRef(): AssetWikiRef | null {
    return parseAssetWikiRef(this.viewType === ViewType.ASSETS ? this.pointer : this.assetSubPointer);
  }

  /**
   * True when this dock addresses the PROJECT ITSELF, not something inside it.
   *
   * `viewType === PROJECT` is NOT that question: `/dock/project/<id>/editor/…`
   * and `/dock/project/<id>/wiki/…` are project-REBASED asset routes that
   * address an asset and merely render in the project shell. Anything treating
   * the bare viewType as "the project page" mislabels every one of them — the
   * address bar called them all "Home".
   */
  get isProjectShell(): boolean {
    return this.viewType === ViewType.PROJECT && this.assetSubPointer === null;
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
  toUrlSegments(): { viewType: ViewType; pointer?: string; layout: Layout; page: PageId } {
    return {
      viewType: this.viewType!,
      pointer: this.urlPointer,
      layout: this.layout,
      page: this.page,
    };
  }

  /**
   * The pointer as it appears in the URL — the stored pointer with the host put
   * back as path segments. The inverse of `fromUrl`'s lift; everything that
   * SERIALIZES a dock goes through here, everything that reads identity or
   * content uses `pointer`.
   */
  private get urlPointer(): string | undefined {
    if (this.viewType !== ViewType.PROJECT) return this.pointer;
    return embedHostInProjectPointer(this.pointer, this.hostProcessId);
  }

  /**
   * Serialize this DockPointer into the canonical layout URL.
   */
  toUrl(currentPath: string = ''): string {
    if (!this.viewType) {
      throw new NavigationError(NavigationErrorType.UNKNOWN_VIEW, 'Cannot serialize DockPointer without a view type');
    }
    // The host leaves as path segments, never as `?host=` — so it is stripped
    // from the query here and re-embedded by `urlPointer`.
    return buildDockUrl(currentPath, this.viewType, this.urlPointer, this.urlOptions, this.layout, this.page);
  }

  /** Options as they appear in the query string — everything except the host,
   *  which `urlPointer` writes into the path instead. */
  private get urlOptions(): Record<string, string> | undefined {
    if (!this.options || !(HOST_PARAM in this.options)) return this.options;
    const { [HOST_PARAM]: _host, ...rest } = this.options;
    return rest;
  }

  /**
   * Convert options to URLSearchParams
   */
  toSearchParams(): URLSearchParams {
    const options = this.urlOptions;
    if (!options) {
      return new URLSearchParams();
    }
    const params = new URLSearchParams();
    Object.entries(options).forEach(([key, value]) => {
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

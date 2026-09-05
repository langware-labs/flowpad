import {
  AgenticProcess,
  ComputeNode,
  CredentialsSubview,
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
import { EVENTS_VIEW_TYPES } from '@src/types/ViewType';
import { getViewMode, rememberedSessionViewMode, ViewMode } from '@src/contexts/view-mode-context';
import { CAPABILITY_PARAM, DockPointer, JOURNEY_PARAM, JOURNEY_STEP_PARAM } from './DockPointer';
import { dockPointerForFile } from './local-file-pointer';
import { getHistoryPosition } from './history-position-store';
import { FileOptions, TabOptions } from './types';
import { preserveWindowLayout, stripDockPortion } from './url-builder';
import { allScope, projectScope } from '@src/lib/scope-filter';
import { isContentAssetDock } from './content-asset-dock';
import { isAdoptableChildDock, isWorkspaceAnchorDock } from './adoptable-child-dock';
import { LOCAL_COMPUTE_NODE } from './asset-doc-types';
import { vfsLocatorForComputeNode } from './vfs-locator';

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

/**
 * How a dock commit should enter browser history.
 *
 * Default is a PUSH, because a navigation is normally something the user chose and
 * Back should undo it. `replace` is for a commit the user did NOT initiate — the
 * agent re-pointing the vibe workspace's active display, or a loader restoring it —
 * where each push would otherwise cost the user one Back press to escape a history
 * they never asked for, and where a pushed entry would immediately redirect forward
 * again (the classic redirect trap).
 */
export interface NavigationCommitOptions {
  replace?: boolean;
}

interface PendingDockNavigation {
  /**
   * Where we are GOING. `navigate()` is async — React Router runs loaders before
   * the URL changes — so for that whole window `window.location` still reports
   * the PREVIOUS location. Anything that composes a URL from the live location
   * during that window and commits it supersedes the navigation in flight.
   *
   * Holding the destination as a POINTER is what makes that unrepresentable:
   * `here` returns this, so a write composes onto the destination instead of
   * rebuilding the location we already left.
   */
  target: DockPointer;
  targetUrl: string;
  sourceUrl: string;
}

let pendingDockNavigation: PendingDockNavigation | null = null;

// View types whose dock adopts the current project's scope when opened without an
// explicit one (see openDock). These are the project-aware browser surfaces: the
// minted Tab attaches to the active project (project tab) or stays global. SHELL
// is included so the Chats/worker rail seeds the active project's scope onto the
// URL — the ChatsNavigator reads currentDock.scopeFilter to filter history, exactly
// like assets/explorer/triggers (SHELL's tabHash ignores scope, so the open
// session's identity is unaffected).
export const SCOPE_SEEDED_VIEWS: ReadonlySet<ViewType> = new Set([
  ViewType.ASSETS,
  // Events (+ its aliases): ONE ScopeFilter drives both halves of the screen —
  // which rules the navigator lists and which events the feed shows. The old
  // Signals screen was deliberately global; folding it in trades that for the
  // filter the user already knows, with `all` scope still available from the
  // scope bar when an instance-wide view is wanted.
  ...EVENTS_VIEW_TYPES,
  ViewType.EXPLORER,
  ViewType.SHELL,
]);

// URL options that are STICKY across navigation: openDock carries each from the
// live URL onto any target that doesn't set it. A param here means "topmost
// until explicitly closed" — clearing it must bypass openDock (see closeJourney).
export const STICKY_OPTION_PARAMS: readonly string[] = [JOURNEY_PARAM, JOURNEY_STEP_PARAM];

/**
 * The workspace host to carry from `here` onto `target`, or null.
 *
 * Both commit paths (`openDock` and `commitDetached`) apply this, so the rule is
 * stated once: content opened from inside a workspace stays in that workspace,
 * and a navigation AWAY — a process, project or list dock — drops it rather than
 * resurrecting a workspace around a top-level surface. `isAdoptableChildDock` is
 * the same predicate that decides whether a tab may adopt a parent at all.
 *
 * Carrying from the live URL, rather than reading the target's own tab row, is
 * what keeps a click inside workspace A in workspace A: one document is one tab
 * however many agents display it, so the row's `parent_tab_id` is
 * last-writer-wins and would teleport the user into whichever workspace showed
 * it most recently.
 */
function hostToCarry(here: DockPointer | null, target: DockPointer): string | null {
  if (!here || target.hostProcessId || !isAdoptableChildDock(target)) return null;
  return here.hostProcessId ?? hostOfWorkspaceAnchor(here);
}

/**
 * The host id when `dock` IS a vibe workspace's anchor — the process dock the
 * Display renders. The anchor cannot carry a `host` option itself (it is not an
 * adoptable child), so this is how content opened while sitting on the Display
 * inherits it — and that is where most opens actually start.
 *
 * Reading the ambient mode here is deliberate, and is NOT the thing
 * `canonicalWorkspaceDisplayPath` refuses to do. That runs in the LOADER, before
 * `applyProjectViewMode` has applied a project's own `last_mode`, so an ambient
 * read there is wrong for exactly the projects that default to vibe. This runs
 * at click time, long after mount, when the effective mode is settled.
 */
function hostOfWorkspaceAnchor(dock: DockPointer): string | null {
  if (!isWorkspaceAnchorDock(dock) || dock.viewType !== ViewType.SHELL) return null;
  return (dock.viewMode ?? getViewMode()) === ViewMode.Vibe ? (dock.pointer ?? null) : null;
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
  constructor(
    private navigate: NavigateFunction,
    private currentDock: DockPointer | null = null,
  ) {
    NavigationActions.clearCommittedPendingNavigation();
  }

  private static getCurrentBrowserUrl(): string {
    return `${window.location.pathname}${window.location.search}`;
  }

  /**
   * WHERE THE APP IS, OR IS ABOUT TO BE — the pointer every URL write composes
   * onto.
   *
   * A navigation in flight wins over the browser's location, because the browser
   * has not moved yet (see {@link PendingDockNavigation.target}). Composing onto
   * the live location during that window is what once let a journey's
   * `?highlight=` write revert the navigation it had just asked for.
   *
   * Never null: the app root is an ordinary pointer now.
   */
  get here(): DockPointer {
    return pendingDockNavigation?.target ?? NavigationActions.currentBrowserDock();
  }

  /** The live browser URL as a pointer. Falls back to the root for a URL we
   *  cannot parse — the app is somewhere, and the root is the safe somewhere. */
  private static currentBrowserDock(): DockPointer {
    try {
      return DockPointer.fromUrl(NavigationActions.getCurrentBrowserUrl());
    } catch {
      return DockPointer.root();
    }
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

  private static clearCommittedPendingNavigation(): void {
    if (!pendingDockNavigation) return;
    const currentUrl = NavigationActions.getCurrentBrowserUrl();
    // A loader may redirect the requested URL to a canonical destination (for
    // example bare /dock/shell → a concrete, project-scoped shell). Either an
    // exact target commit or any departure from the stamped source proves the
    // transition finished; retaining the raw requested URL after a redirect
    // suppresses the next legitimate click until the fallback timer fires.
    if (currentUrl === pendingDockNavigation.targetUrl || currentUrl !== pendingDockNavigation.sourceUrl) {
      pendingDockNavigation = null;
    }
  }

  private markPendingNavigation(target: DockPointer, targetUrl: string): void {
    const pending = {
      target,
      targetUrl,
      sourceUrl: NavigationActions.getCurrentBrowserUrl(),
    };
    pendingDockNavigation = pending;
    window.setTimeout(() => {
      if (pendingDockNavigation === pending && NavigationActions.getCurrentBrowserUrl() !== targetUrl) {
        pendingDockNavigation = null;
      }
    }, 1000);
  }

  // `viewType:pointer` label for the navigation toplog trace.
  // `viewType` is optional because a DockPointer's is — this is a log label, and
  // every caller hands it a real DockPointer.
  private static dockLabel(d: { viewType?: string; pointer?: string | null } | null): string | null {
    return d ? `${d.viewType}:${d.pointer ?? ''}` : null;
  }

  private commitBrowserNavigation(
    target: DockPointer,
    fullUrl: string,
    routerUrl: string,
    opts?: NavigationCommitOptions,
  ): void {
    this.markPendingNavigation(target, fullUrl);

    const from = NavigationActions.getCurrentBrowserUrl();
    const willNavigate = from !== fullUrl;
    toplog.log('navigation', 'commitBrowserNavigation', {
      from,
      to: fullUrl,
      routerUrl,
      willNavigate,
      replace: opts?.replace === true,
      historyLen: window.history.length,
    });
    if (willNavigate) {
      // React Router owns browser history and, critically, loader execution.
      // A hand-written pushState/popstate updates useLocation but can bypass
      // data-router revalidation, leaving the new URL rendered against stale
      // context. Every dock transition therefore enters through navigate().
      void this.navigate(routerUrl, opts?.replace ? { replace: true } : undefined);
    }
  }

  /**
   * Commit a pointer from OUTSIDE the react-router context.
   *
   * The normal path goes through `navigate()` because React Router owns history
   * and, critically, loader execution. A few callers are mounted above the
   * router (the ui_command listener) and have no `navigate` to call, so they
   * push and fire a synthetic popstate for the data router to pick up.
   *
   * That idiom lives HERE rather than being re-spelled per caller — it was
   * already duplicated, with string equality where pointer equality belongs, so
   * a param reordering counted as a different URL and re-pushed.
   */
  static commitDetached(pointer: IDockPointer): void {
    let target = pointer instanceof DockPointer ? pointer : new DockPointer(pointer);
    let here: DockPointer | null = null;
    try {
      here = DockPointer.fromUrl(NavigationActions.getCurrentBrowserUrl());
    } catch {
      here = null;
    }
    // A backend-driven navigate onto workspace content stays in the workspace.
    const carriedHost = hostToCarry(here, target);
    if (carriedHost) target = target.withHost(carriedHost);
    const url = target.toUrl(window.location.pathname);
    if (here?.equals(target)) return;
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  static resetPendingNavigationForTests(): void {
    pendingDockNavigation = null;
  }

  /**
   * Navigate to the home root with `?highlight=<wikiword>` set, so a home/feed
   * element matching that wiki word renders highlighted. URL-carried (shareable,
   * back-button-safe), mirroring the `selected` option — see docs/wikitip.md.
   * Used by the WikiTip backward link ("click here to highlight the feedentry").
   */
  highlight(wikiword: string): void {
    this.openHomeRoot(wikiword);
  }

  /**
   * Commit a pointer AS-IS — no sticky carry-forward, no scope seeding.
   *
   * The escape hatch for writes that must be able to REMOVE an option
   * (`closeJourney`, `endJourneySteps`) or that are pure param edits on the
   * current surface (`setOption`), where `openDock`'s carry-forward would put
   * back what we are trying to drop. Composition happens on the pointer, so there is
   * no URL string to get stale.
   */
  private commitPointer(dock: DockPointer): void {
    NavigationActions.clearCommittedPendingNavigation();
    const url = dock.toUrl(window.location.pathname);
    if (NavigationActions.getCurrentBrowserUrl() === url) return;
    this.commitBrowserNavigation(dock, url, url);
  }

  /**
   * Leave the journey's step sequence, keeping the journey shown.
   *
   * Lives here beside `showJourney`/`closeJourney` because clearing a STICKY
   * param must bypass `openDock`'s carry-forward — a navigation-layer rule that
   * callers should not have to know, and that a second copy of would drift.
   */
  endJourneySteps(): void {
    this.setOption(JOURNEY_STEP_PARAM, null);
  }

  /**
   * Set (or clear, with `null`) one URL option on the current surface.
   *
   * The typed form of "tweak a param in place" — composed on {@link here}, so a
   * write during an in-flight navigation lands on the destination rather than
   * rebuilding the location we already left. Call sites used `useSearchParams`'s
   * setter, which reads React-state search params and therefore has exactly that
   * staleness.
   */
  setOption(key: string, value: string | null): void {
    this.commitPointer(this.here.withOption(key, value));
  }

  /**
   * Navigate to the app home root `/`, optionally with `?highlight=`.
   *
   * An ordinary `openDock` now: the root is a pointer, so sticky options
   * (journeyId) ride along through the one carry-forward in `openDock` rather
   * than a hand-copied loop here. Also the surface a journey names as
   * `start: {kind: "root"}`.
   */
  private openHomeRoot(highlightWord?: string): void {
    const root = DockPointer.root();
    this.openDock(highlightWord ? root.withHighlight(highlightWord) : root);
  }

  /**
   * "Take me home" — the destination, wherever it is asked from.
   *
   * The two surfaces differ: the hub keeps every navigation under `page=hub`
   * (a desk factory would revert the page and land on the desk home), while the
   * desk home is the app root, which is NOT a dock URL and so needs
   * `openHomeRoot` to carry the sticky options forward. Stated once here so the
   * nav bar — and the next entry point (spotlight, a shortcut, a journey) —
   * can't each re-derive the branch, and so the pending `TODO(nav)` about
   * committing through the router has exactly one place left to land.
   */
  goHome(): void {
    // Two surfaces, one navigation. The hub keeps every navigation under
    // `page=hub` (a desk factory would revert the page and land on the desk
    // home); the desk home is the app root. Both are pointers, so the branch is
    // a choice of destination rather than a choice of mechanism.
    this.openDock(this.here.page === PageId.HUB ? DockPointer.forHome().withPage(PageId.HUB) : DockPointer.root());
  }

  /** The journey shown where we are (or are going), or null. */
  private currentJourneyId(): string | null {
    return this.here.journeyId;
  }

  /**
   * Show a user journey on the CURRENT surface — sets `?journeyId=` on the
   * current dock pointer (or the home root when not on a dock URL). The journey
   * then rides every subsequent navigation via openDock's carry-forward, so it
   * stays topmost until {@link closeJourney}. URL-carried ⇒ reload-safe.
   */
  showJourney(journeyId: string): void {
    // One path for every surface. The old home-root branch hand-built
    // `/?journeyId=…`, which DROPPED every other param on the way — `highlight`
    // included. Composing on the pointer cannot lose the rest of the location.
    this.openDock(this.here.withJourney(journeyId));
  }

  /**
   * Explicitly close the journey — the ONLY thing that clears `journeyId`.
   * Commits the stripped URL directly instead of going through `openDock`,
   * whose carry-forward would immediately put the param back.
   */
  closeJourney(): void {
    if (!this.currentJourneyId()) return;
    // `commitPointer`, not `openDock`: the sticky carry-forward would put the
    // param straight back. This is the one thing that clears it.
    this.commitPointer(this.here.withJourney(null));
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
  openDock(pointer: DockPointer | null, extraOptions?: Record<string, string>, opts?: NavigationCommitOptions): void;
  openDock(pointer: IDockPointer, extraOptions?: Record<string, string>, opts?: NavigationCommitOptions): void;
  openDock(
    pointer: IDockPointer | DockPointer | null,
    extraOptions?: Record<string, string>,
    opts?: NavigationCommitOptions,
  ): void {
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
      // Closing the dock IS going to the root, and the root is an ordinary
      // pointer — `buildDockUrl` already returns the base path (or `/`) for it,
      // which is exactly what the hand-rolled strip-and-normalize did.
      this.commitPointer(DockPointer.root());
      return;
    }

    const base = pointer instanceof DockPointer ? pointer : new DockPointer(pointer);
    let dock =
      extraOptions && Object.keys(extraOptions).length > 0
        ? new DockPointer(base.viewType, base.pointer, { ...base.options, ...extraOptions }, base.layout, base.page)
        : base;

    // STICKY URL options: each listed param rides onto any target that doesn't
    // set it, read from WHERE WE ARE (or are going) — one carry-forward for
    // every surface now that the home root is an ordinary pointer, where it used
    // to need a hand-copied duplicate in `openHomeRoot`. `journeyId` is the
    // first: a shown journey is TOPMOST until `closeJourney()` (which commits
    // directly so the param can actually clear). New sticky params are one table
    // entry, not another bespoke block.
    const here = this.here;
    for (const key of STICKY_OPTION_PARAMS) {
      const live = here.options?.[key];
      if (live && !dock.options?.[key]) {
        dock = dock.withOption(key, live);
      }
    }

    // The workspace host is sticky the same way, but ONLY onto surfaces that may
    // live inside a workspace — the same predicate that decides whether a tab may
    // adopt a parent. Navigating to a process, a project or a list is a
    // navigation AWAY, and inheriting the host there would resurrect a workspace
    // around a top-level surface. Carrying it from the live URL is what keeps a
    // click inside workspace A in workspace A, rather than following the shown
    // document's last writer into workspace B.
    const carriedHost = hostToCarry(here, dock);
    if (carriedHost) dock = dock.withHost(carriedHost);

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
    if (
      dock.viewType &&
      SCOPE_SEEDED_VIEWS.has(dock.viewType) &&
      dock.scopeFilter === null &&
      !isContentAssetDock(dock)
    ) {
      const projectId = dataContext.project?.id ?? null;
      dock = dock.withScopeFilter(projectId ? projectScope(projectId) : allScope());
    }

    // Inherit the live URL's ?viewMode unless the target names its own (mirrors
    // the scope-seed above); explicit target / ViewToggle mode still wins. Since
    // useDockViewModeOverrideSync now adopts the URL's mode into the persisted
    // preference on load, this inheritance matters only for navigations issued
    // BEFORE that adopt effect commits (e.g. a redirect right after a hard load
    // on a ?viewMode URL) — not for general mode stickiness.
    //
    // The ROOT is stamped too (2026-09-03). It used to be excluded, to keep the
    // canonical home URL bare and let the persisted preference decide the mode
    // there — but a bare entry does not STATE its mode, it re-resolves through a
    // preference that the ViewToggle itself mutates. So Back onto a home entry
    // rendered it in the mode you had just switched TO: a history step that
    // visibly did nothing, with Forward lit. Every entry must state its own mode
    // for a Back step to be visible, home included. The cold-load entry is
    // canonicalized in `loadHomePage`, which this cannot reach.
    //
    // A SESSION dock is the exception, and takes its own remembered mode
    // instead: a session opens in the mode it was last seen in, so switching to
    // Terminal in one chat no longer repaints every other chat you click into.
    // Inheritance is still the fallback for a session with no memory yet (a new
    // one, or one that predates the field) — it adopts the ambient mode and
    // records it on load. Cache-only: a cold deep link has no entity to read
    // here, and the loader's `applyProcessViewMode` covers that path.
    if (dock.viewMode === null) {
      const liveViewMode =
        rememberedSessionViewMode(dock) ??
        NavigationActions.currentBrowserViewMode() ??
        this.currentDock?.viewMode ??
        null;
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

    if (currentUrl === fullUrl || pendingDockNavigation?.targetUrl === fullUrl) {
      toplog.log('navigation', 'openDock no-op (URL already current/pending)', {
        currentUrl,
        fullUrl,
        pending: pendingDockNavigation?.targetUrl ?? null,
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

    this.commitBrowserNavigation(targetDock, fullUrl, url, opts);
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

  /**
   * Commit a pointer WITHOUT adding a history entry.
   *
   * Same path as {@link openDock} — sticky options, host carry, round-trip check and
   * all — differing only in how it enters history. Exists so the intent reads at the
   * call site: this navigation was not the user's choice, so Back should skip it.
   *
   * The caller is the vibe workspace's active display, where the agent may show a
   * dozen targets in one turn. Pushing each would bury whatever the user was doing a
   * dozen Back presses deep; the show history stays browsable through the display
   * history popover, which is where it belongs.
   */
  replaceDock(pointer: DockPointer | null, extraOptions?: Record<string, string>): void {
    this.openDock(pointer, extraOptions, { replace: true });
  }

  // ========== Tab Navigation (Shortcuts) ==========

  openTab(tabType: ViewType, options?: TabOptions): void {
    const pointer = DockPointer.forTab(tabType, {
      ...(options?.pinned !== undefined && { pinned: options.pinned.toString() }),
      ...(options?.capabilityKind ? { [CAPABILITY_PARAM]: options.capabilityKind } : {}),
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

  // ========== Content Navigation (Shortcuts) ==========

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
   * Open a FILE addressed by ABSOLUTE MACHINE path, on a given entity.
   *
   * Dock pointers address files as VFS paths (`compute_node-<id>/abs/path`), so
   * every caller holding a real filesystem path has to convert first — and each
   * one that did it inline was a chance for the two forms to drift. Same job as
   * `openFolder` does for directories; `openFile` remains the VFS-path entry.
   */
  openMachinePath(machinePath: string, typeId: TypeId, options?: FileOptions): void {
    this.openFile(VFSPath.fromMachinePath(machinePath, typeId).rawPath, options);
  }

  /**
   * Open a FOLDER in the Assets fs browser — the folder counterpart of
   * `openFile`. `openFile` would render a directory path as an empty file, so
   * any surface that has a directory (file browsers, task artifacts) routes it
   * here. Converts the absolute machine path to the compute-node-relative form
   * the `fs/` pointer expects (handles POSIX `/…` and Windows `C:\…`).
   */
  openFolder(machinePath: string): void {
    const parsed = VFSPath.parse(machinePath);
    if (parsed.isAbsolute) {
      this.openDock(DockPointer.forAssetFs(parsed));
      return;
    }

    const liveTypeId = dataContext.computeNodeTypeId ?? LOCAL_COMPUTE_NODE;
    const locatorTypeId = vfsLocatorForComputeNode(dataContext.computeNode) ?? liveTypeId;
    const vfsPath =
      machinePath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(machinePath)
        ? VFSPath.fromMachinePath(machinePath, locatorTypeId)
        : VFSPath.fromTypeId(locatorTypeId, machinePath);
    this.openDock(DockPointer.forAssetFs(vfsPath));
  }

  /** Navigate to the default shell view (no specific session) */
  openShellView(): void {
    this.openDock(new DockPointerData(ViewType.SHELL));
  }

  async openShell(
    shellId: string,
    options?: {
      cwd?: string;
      /** Typed AND submitted once the terminal attaches. */
      startCommand?: string;
      /** Typed and left at the prompt — the user presses Enter. */
      prefillCommand?: string;
      skipPermissions?: boolean;
      viewMode?: string;
      host?: string;
    },
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

  async openNewShell(options?: {
    cwd?: string;
    /** Typed AND submitted once the terminal attaches. */
    startCommand?: string;
    /** Typed and left at the prompt — the user presses Enter. */
    prefillCommand?: string;
    computeNode?: ComputeNode;
    skipNavigate?: boolean;
    projectId?: string;
    /** Open the terminal in this view mode (`vibe` keeps a journey in its skin). */
    viewMode?: string;
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
   * Open the user Preferences screen
   * @param category - Optional category whose tab should be active
   */
  openPreferences(category?: string): void {
    const pointer = DockPointer.forPreferences(category);
    this.openDock(pointer);
  }

  /**
   * Open the Credentials screen (Environment / Connections / API Keys)
   * @param tab - Which tab is active; defaults to Connections
   * @param projectId - Project whose environment is shown
   */
  openCredentials(tab?: CredentialsSubview, projectId?: string): void {
    const pointer = DockPointer.forCredentials(tab, projectId);
    this.openDock(pointer);
  }

  // ========== History Navigation ==========

  /**
   * Step back one entry — but only if there IS one. Unguarded, `navigate(-1)`
   * on a freshly deep-linked page walks out of the app entirely (to whatever
   * the tab showed before, or a blank page in the Electron shell).
   *
   * This is the HISTORY affordance and nothing else. A view that wants "leave
   * this thing" should name its destination — `openDock(DockPointer.forX())` —
   * rather than depend on where the user happened to come from.
   */
  goBack(): void {
    const { canGoBack, idx } = getHistoryPosition();
    toplog.log('navigation', 'NavigationActions.goBack', {
      canGoBack,
      idx,
      currentUrl: NavigationActions.getCurrentBrowserUrl(),
      currentDock: NavigationActions.dockLabel(this.currentDock),
    });
    if (!canGoBack) return;
    void this.navigate(-1);
  }

  goForward(): void {
    const { canGoForward, idx } = getHistoryPosition();
    toplog.log('navigation', 'NavigationActions.goForward', {
      canGoForward,
      idx,
      currentUrl: NavigationActions.getCurrentBrowserUrl(),
    });
    if (!canGoForward) return;
    void this.navigate(1);
  }
}

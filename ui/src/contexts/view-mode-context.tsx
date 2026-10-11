import {
  AgenticProcess,
  type IDockPointer,
  instancePreferences,
  onPreferenceChange,
  PREF_REGISTRY,
  PrefKey,
  TypeId,
  ViewModeEvent,
  viewModeMemory,
} from '@sdk';
import { usePreferenceValue } from '@src/hooks/use-preference';
import { defineGlobal } from '@sdk/utils';
import { createContext, type ReactNode, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { NavigationType, useLocation, useNavigationType } from 'react-router';
import { useCurrentDock } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';

declare global {
  interface Window {
    setView: (val: ViewMode) => void;
    getView: () => ViewMode;
    setDev: (val?: boolean) => void;
    getDev: () => boolean;
  }
}

/**
 * A view mode is a session SURFACE — read with `surfaceForViewMode` (vibe
 * workspace / chat pane / xterm) — stated by each tab's own URL. The chrome
 * TIER is no longer part of it: power-user chrome (`AdvancedOnly`, `DevOnly`,
 * `useIsAdvanced`) follows the developer-mode SWITCH (`useIsDev`), on any surface.
 * `Dev` stays in the enum only for addresses and stored values written while it
 * was a mode.
 */
export enum ViewMode {
  // Hierarchy (simplest → fullest): Vibe ⊂ Standard ⊂ Advanced ⊂ Dev.
  Vibe = 'vibe',
  Standard = 'standard',
  Advanced = 'advanced',
  Dev = 'dev',
}

// The stored `preferences.ui.view_mode` is kept as state (the session switch still
// writes it, and view-mode memory reads it), but NO UI decides anything from it:
// an address that states no mode shows `UNSTATED_VIEW_MODE`. The mode on screen is
// reflected as a `data-view` attribute on the document root so CSS can react.

// Strict validator: unknown/garbage reads as *unset* (null). Used directly for
// values adopted from a Project's stored `last_mode`, where a default fallback
// would silently launder bad data into a remembered preference.
function toViewModeOrNull(v: unknown): ViewMode | null {
  return v === ViewMode.Standard || v === ViewMode.Advanced || v === ViewMode.Dev || v === ViewMode.Vibe
    ? (v as ViewMode)
    : null;
}

function toViewMode(v: unknown): ViewMode {
  return toViewModeOrNull(v) ?? toViewModeOrNull(PREF_REGISTRY[PrefKey.VIEW_MODE].defaultValue) ?? ViewMode.Standard;
}

/**
 * The SURFACE a view mode shows an agent session in — the single mapping that
 * makes View mode the one mode selector. Vibe is the vibe workspace, Standard is
 * the chat pane, Advanced/Dev is the raw terminal.
 *
 * This used to be a second preference (`chat mode`), which could and did drift
 * out of sync with View mode — both carried a `vibe` and each control wrote only
 * its own. One enum, one preference, one control.
 */
export type SessionSurface = 'vibe' | 'chat' | 'terminal';

export function surfaceForViewMode(mode: ViewMode): SessionSurface {
  if (mode === ViewMode.Vibe) return 'vibe';
  return mode === ViewMode.Advanced || mode === ViewMode.Dev ? 'terminal' : 'chat';
}

/** Transport for a mode: only the terminal surface runs an interactive PTY. */
export function viewModePtyMode(mode: ViewMode): boolean {
  return surfaceForViewMode(mode) === 'terminal';
}

/**
 * Reactive session surface. Always known: it follows the tab's stated mode (its
 * URL) or the app's one mode, never the stored preference — so there is no
 * first-paint wait for `preferences.json` (which there used to be, while the
 * preference decided it).
 */
export function useSessionSurface(): SessionSurface {
  return surfaceForViewMode(useViewMode());
}

const viewModeOverrideListeners = new Set<() => void>();
// The mode a viewMode-carrying dock URL displays. Loading such a URL does NOT
// save it into the persisted preference — only a switch does
// (useDockViewModeOverrideSync) — so this can differ from the pref, and anything
// that acts on "the current mode" must read getEffectiveViewMode(), not the pref.
let dockViewModeOverride: ViewMode | null = null;
let flickerTimer: number | undefined;

function subscribeViewModeOverride(listener: () => void): () => void {
  viewModeOverrideListeners.add(listener);
  return () => viewModeOverrideListeners.delete(listener);
}

function getViewModeOverrideSnapshot(): ViewMode | null {
  return dockViewModeOverride;
}

/**
 * The mode a surface shows when nothing STATES one. The stored `view_mode`
 * preference is kept (URLs still carry `?viewMode`, the session switch still
 * writes it) but no UI decides anything from it any more: everything is a tab,
 * a tab states its own surface in its URL, and an address that states none is
 * the app's one mode — Vibe.
 */
export const UNSTATED_VIEW_MODE = ViewMode.Vibe;

/**
 * The active mode for non-React callers — the same value `useViewMode()`
 * resolves to, without the hook: the mounted dock's stated mode, else
 * {@link UNSTATED_VIEW_MODE}. Never the stored preference.
 */
export function getEffectiveViewMode(): ViewMode {
  return dockViewModeOverride ?? UNSTATED_VIEW_MODE;
}

// Vibe's display font (Plus Jakarta Sans) is injected only when Vibe is actually
// active, so Standard/Advanced/Dev users never fetch it. NOTE: Vibe is now the
// default mode, so the common path DOES take this on boot — `applyAttribute` runs
// at module load below, and a <link rel="stylesheet"> in <head> is render-blocking
// on a cross-origin round-trip. Self-hosting or preconnecting the font would get
// that off first paint; lazy injection alone no longer buys what it used to.
let vibeFontInjected = false;
function ensureVibeFont(): void {
  if (vibeFontInjected || typeof document === 'undefined') return;
  vibeFontInjected = true;
  const link = document.createElement('link');
  link.id = 'vibe-font';
  link.rel = 'stylesheet';
  link.href =
    'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&display=swap';
  document.head.appendChild(link);
}

// Mirror developer mode to the Electron application menu: it is shown only with
// Dev on (see electron/main.js `set-menu-visible`), on any surface. A no-op in
// the browser build (no electronAPI).
let lastMenuVisibleSent: boolean | null = null;
function syncDesktopMenu(): void {
  const visible = getDev();
  if (visible === lastMenuVisibleSent) return;
  const setMenuVisible = (
    window as unknown as {
      electronAPI?: { setMenuVisible?: (visible: boolean) => void };
    }
  ).electronAPI?.setMenuVisible;
  if (typeof setMenuVisible !== 'function') return;
  lastMenuVisibleSent = visible;
  setMenuVisible(visible);
}

function applyAttribute(val: ViewMode, animate = true): void {
  if (val === ViewMode.Vibe) ensureVibeFont();
  const root = document.documentElement;
  const prev = root.getAttribute('data-view');
  // Guard: prefMan fires on EVERY pref change, but only a view-mode change need
  // touch the DOM. Skip the write when the attribute already matches.
  if (prev !== val) {
    root.setAttribute('data-view', val);
    if (animate && prev != null) {
      root.classList.remove('view-mode-glow-flicker');
      // Restart the CSS animation even when changes happen in quick succession.
      void root.offsetWidth;
      root.classList.add('view-mode-glow-flicker');
      if (flickerTimer !== undefined) window.clearTimeout(flickerTimer);
      // Hold the element, not the `document` global: this timer can outlive the
      // document (a jsdom test environment is torn down between files), and
      // dereferencing the global afterwards throws `document is not defined`,
      // which vitest reports as an unhandled error and fails an otherwise green run.
      flickerTimer = window.setTimeout(() => {
        root.classList.remove('view-mode-glow-flicker');
        flickerTimer = undefined;
      }, 700);
    }
  }
}

function setDockViewModeOverride(val: ViewMode | null, animate = true): void {
  if (dockViewModeOverride === val) {
    applyAttribute(getEffectiveViewMode(), false);
    return;
  }
  dockViewModeOverride = val;
  applyAttribute(getEffectiveViewMode(), animate);
  viewModeOverrideListeners.forEach((listener) => listener());
}

// One-time carry of the oldest encoding, a `devMode` localStorage boolean, onto
// the Dev switch (it went through viewMode=dev while Dev was a mode).
if (typeof localStorage !== 'undefined' && localStorage.getItem('devMode') === 'true') {
  localStorage.removeItem('devMode');
  instancePreferences.set(PrefKey.DEV_MODE, true);
}

export function getViewMode(): ViewMode {
  return toViewMode(instancePreferences.get(PrefKey.VIEW_MODE));
}

// View-mode MEMORY (`last_mode` on a session or project) is read here and in
// navigation, and written ONLY through the SDK's `viewModeMemory`, whose
// `VIEW_MODE_STORE` policy decides which events mint it. Restoring a mode never
// writes: a remembered mode reaches the screen by being stated on the URL.

/** A target's remembered mode, or null when it has none (or garbage). */
export function rememberedViewMode(target: { last_mode?: string | null } | null | undefined): ViewMode | null {
  return toViewModeOrNull(target?.last_mode ?? null);
}

/**
 * The id of the session a dock addresses, or null when it addresses something
 * else. A session is shown at `/dock/shell/agentic_process-<id>` or as the Vibe
 * host tab `/dock/vibe/agentic_process-<id>` (`DockPointer.isSessionView`), so this
 * is the whole grammar.
 */
export function sessionIdForDock(dock: IDockPointer): string | null {
  if (!DockPointer.isSessionView(dock.viewType) || !dock.pointer) return null;
  const prefix = AgenticProcess.type + TypeId.DELIMITER;
  return dock.pointer.startsWith(prefix) ? dock.pointer.slice(prefix.length) : null;
}

/**
 * The mode a session with no memory of its own opens in: the last one the user
 * SELECTED (the stored preference, which only a mode switch writes). Dev reads
 * as the terminal it showed.
 */
function lastSelectedViewMode(): ViewMode {
  const mode = getViewMode();
  return mode === ViewMode.Dev ? ViewMode.Advanced : mode;
}

/** The mode a session opens in when its address states none: its own memory,
 *  else the last mode the user selected. The ONE rule — the opener and the shell
 *  loader both ask it, so a warm open and a cold load cannot disagree. */
export function sessionOpenViewMode(session: { last_mode?: string | null } | null | undefined): ViewMode {
  return rememberedViewMode(session) ?? lastSelectedViewMode();
}

/**
 * THE mode switch: persist `val` as the last selected mode and record it on the
 * session `dock` shows. Every path that changes mode on purpose — the in-session
 * switch's navigation (via `useDockViewModeOverrideSync`), `window.setView` —
 * lands here, and nothing that merely opens or restores a tab does.
 */
export function setViewMode(val: ViewMode, dock: IDockPointer | null = null): void {
  instancePreferences.set(PrefKey.VIEW_MODE, val);
  applyAttribute(getEffectiveViewMode());
  viewModeMemory.record(ViewModeEvent.ModeSwitch, { tab: viewModeMemory.targetFor(dock?.targetTypeId) }, val);
}

/**
 * The `?viewMode=` carried by the address being loaded, if it names a real mode.
 *
 * URL-first (CLAUDE.md, non-negotiable): the address is authoritative for what is
 * shown, so it must win from the FIRST paint, not after a repaint. Import-time
 * paint used to read ONLY the persisted preference, so `/?viewMode=vibe` painted
 * `data-view="standard"`; the attribute was corrected later only if a
 * preference-CHANGE event happened to fire, and when the stored value is already
 * resolved at boot no such event ever comes, so the URL simply lost.
 * (`getEffectiveViewMode()` cannot close this: its `dockViewModeOverride` is still
 * null at module import — `useDockViewModeOverrideSync` populates it once the dock
 * mounts.) Reading the param here fixes the ordering at its source; it is not a
 * wait, a retry, or a timing budget.
 *
 * Strict by construction: `toViewModeOrNull` returns null for anything that is not
 * a real mode, so a junk param falls through to `UNSTATED_VIEW_MODE`.
 */
function viewModeFromLocation(): ViewMode | null {
  try {
    // The address states the mode — an option, or implied by a Vibe host dock
    // (`DockPointer.viewMode`). A non-dock path has none.
    return DockPointer.fromUrl(`${window.location.pathname}${window.location.search}`).viewMode;
  } catch {
    return null;
  }
}

// Keep `data-view` in sync with prefMan: on import (first paint) and on every change,
// including a cross-device backend value reconciled in on load. The URL's mode
// outranks the stored preference on that first paint (see viewModeFromLocation).
/**
 * The mode the `data-view` ATTRIBUTE should show right now.
 *
 * Deliberately NOT `getEffectiveViewMode()`: the override is null until the dock
 * mounts, so that would paint `UNSTATED_VIEW_MODE` over the URL's own mode on the
 * first paint. The URL sits between the two: a mounted dock override still wins,
 * otherwise the address decides, and only then the unstated mode.
 *
 * Scoped to the attribute ON PURPOSE. Seeding `dockViewModeOverride` from the
 * URL instead was tried and reverted: that value also feeds `openDock`'s
 * canonicalization, and pinning it there broke pointer routing (dock_sweep went
 * 2 failures -> 8-9, landing on the wrong paths). Painting is presentation;
 * routing is not.
 */
function attributeViewMode(): ViewMode {
  return dockViewModeOverride ?? viewModeFromLocation() ?? UNSTATED_VIEW_MODE;
}

applyAttribute(attributeViewMode(), false);
syncDesktopMenu();
onPreferenceChange(() => {
  applyAttribute(attributeViewMode());
  syncDesktopMenu();
});

defineGlobal('setView', setViewMode);
defineGlobal('getView', getViewMode);

// --- Dev mode: a SWITCH, not a view mode ---
//
// Dev used to be the fourth view mode (Vibe < Standard < Advanced < Dev). That
// made it unreachable where it is needed most: on a session tab the URL's own
// `?viewMode=` wins over the stored mode, so Dev was shadowed on every terminal,
// chat and Vibe tab. It is now its own preference, layered over whichever
// surface is showing. A stored `view_mode = "dev"` — written while Dev was a
// mode — still reads as Dev on, so nobody silently drops out of it; the next
// toggle retires that value (to Advanced, the surface Dev showed).

/** Whether developer mode is on. */
export function getDev(): boolean {
  return isDevOn(instancePreferences.get(PrefKey.DEV_MODE), instancePreferences.get(PrefKey.VIEW_MODE));
}

function isDevOn(devPref: unknown, viewModePref: unknown): boolean {
  return devPref === true || viewModePref === ViewMode.Dev;
}

/** Non-hook {@link useTierMode}. */
export function getTierMode(): ViewMode {
  return getDev() ? ViewMode.Dev : UNSTATED_VIEW_MODE;
}

/** Turn developer mode on/off; no argument toggles. */
export function setDev(val?: boolean): void {
  const next = val ?? !getDev();
  if (getViewMode() === ViewMode.Dev) instancePreferences.set(PrefKey.VIEW_MODE, ViewMode.Advanced);
  instancePreferences.set(PrefKey.DEV_MODE, next);
}

defineGlobal('setDev', setDev);
defineGlobal('getDev', getDev);

/**
 * The mode a session pane OFF SCREEN stays in: the one it was last shown in.
 *
 * Session panes are kept alive when you move to another tab or page. The mode on
 * screen then belongs to wherever you went — and a hidden chat that followed it
 * re-rendered as another surface, so the reader came back to a different place.
 * Null outside a pane (and for the pane on screen): the live mode applies.
 */
const PinnedViewModeContext = createContext<ViewMode | null>(null);

/** Wrap a kept-alive session pane (`pointer`: the session it shows). While that
 *  session is the one on screen it follows the live mode; otherwise it keeps the
 *  last mode it was shown in. Keyed on the ADDRESS, not only on `active`: the
 *  two flip in different renders, and a pane still marked active for a frame
 *  must not adopt the mode of the place just navigated to. */
export function SessionPaneViewMode({
  active,
  pointer,
  children,
}: {
  active: boolean;
  pointer: string | null | undefined;
  children: ReactNode;
}) {
  const live = useLiveViewMode(false);
  const here = useCurrentDock();
  const onScreen = active && !!pointer && here?.pointer === pointer && DockPointer.isSessionView(here.viewType);
  const shown = useRef<ViewMode | null>(null);
  if (onScreen) shown.current = live;
  const mode = onScreen ? live : (shown.current ?? live);
  // `data-pane-view` pins the pane's TEXT METRICS (styles/index.css) to its own
  // mode: the document's skin follows the place on screen, and a hidden pane
  // whose font followed it reflowed — and lost the reader's scroll position.
  return (
    <PinnedViewModeContext.Provider value={onScreen ? null : mode}>
      <div data-pane-view={mode} className="contents">
        {children}
      </div>
    </PinnedViewModeContext.Provider>
  );
}

export function useViewMode(): ViewMode {
  const pinned = useContext(PinnedViewModeContext);
  const live = useLiveViewMode(pinned === null);
  return pinned ?? live;
}

/** The mode on screen. `paint`: also reflect it on the document root (never for
 *  a pinned, off-screen reader — its mode is not the one on screen). */
function useLiveViewMode(paint = true): ViewMode {
  const currentDock = useCurrentDock();
  const override = useSyncExternalStore(
    subscribeViewModeOverride,
    getViewModeOverrideSnapshot,
    getViewModeOverrideSnapshot,
  );
  // URL-first: a committed dock URL is authoritative immediately; the transient
  // override is a projection adopted by a later effect. An address that states
  // no mode shows the app's one mode — never the stored preference.
  const mode = currentDock?.viewMode ?? override ?? UNSTATED_VIEW_MODE;
  useEffect(() => {
    if (paint) applyAttribute(mode);
  }, [mode, paint]);
  return mode;
}

/** History state a user's mode switch travels with — see `useDockViewModeOverrideSync`. */
export const VIEW_MODE_SWITCH_STATE = { viewModeSwitch: true } as const;

export function isViewModeSwitchState(state: unknown): boolean {
  return (state as { viewModeSwitch?: unknown } | null)?.viewModeSwitch === true;
}

/**
 * Sync the current DockPointer's viewMode override into useViewMode(), and turn
 * a mode SWITCH into `setViewMode`.
 *
 * The session switch only navigates (same pointer, another mode), so a
 * switch is read off the URL transition rather than written in the click path:
 * the SAME dock committing with a DIFFERENT mode. Any other load — opening a
 * tab, a seeded or explicit opener mode, a redirect that adds the mode to a bare
 * URL — only displays its mode. That is what keeps memory and the preference
 * from being minted by merely looking at something.
 */
export function useDockViewModeOverrideSync(): void {
  const currentDock = useCurrentDock();
  const override = currentDock?.viewMode ?? null;
  const previous = useRef(currentDock);
  const marked = isViewModeSwitchState(useLocation().state);
  const replayed = useNavigationType() === NavigationType.Pop;

  useEffect(() => {
    const prev = previous.current;
    previous.current = currentDock;
    // The glow marks a MODE SWITCH — the same place in another mode. Moving to
    // another tab (a Vibe tab ⇄ a terminal tab) repaints the skin without it.
    // A session's own CHILD (its Vibe workspace showing a document) is the same
    // place too: "Open terminal" switches the session from wherever in it you are.
    const samePlace =
      !!prev &&
      !!currentDock &&
      (prev.withViewMode(null).equals(currentDock.withViewMode(null)) ||
        (!!prev.hostProcessId && prev.hostProcessId === currentDock.pointer));
    setDockViewModeOverride(override, samePlace);
    if (!currentDock || !override) return;
    // The mode a session is SHOWN in is the mode its tab remembers — however it
    // got on screen (a switch, an address, Back/Forward) — so leaving and coming
    // back never changes it.
    viewModeMemory.record(ViewModeEvent.TabOpen, { tab: viewModeMemory.targetFor(currentDock.targetTypeId) }, override);
    // SELECTING a mode is the user's own switch, and nothing else: it navigates
    // with the marker. A redirect that states a mode, an address, and a
    // Back/Forward step onto an old switch all only display.
    if (marked && !replayed && samePlace && prev?.viewMode !== override) setViewMode(override, currentDock);
  }, [currentDock, override, marked, replayed]);

  useEffect(() => () => setDockViewModeOverride(null), []);
}

/** Advanced UI == developer mode: the power-user extras show only with Dev on. */
export function useIsAdvanced(): boolean {
  return useIsDev();
}

/** Semantic boolean accessor — true while developer mode is on, on any surface. */
export function useIsDev(): boolean {
  // Value subscriptions, not `usePreference`: ~40 always-mounted consumers (rail,
  // avatar, every Advanced gate) re-render only when one of THESE two changes,
  // not on every preference save.
  const dev = usePreferenceValue<boolean>(PrefKey.DEV_MODE);
  const stored = usePreferenceValue<string>(PrefKey.VIEW_MODE);
  return isDevOn(dev, stored);
}

/**
 * The mode for TIER questions — which rail items, which browseable types: Dev
 * with developer mode on, else the base tier. Never the surface on screen:
 * a terminal tab and a Vibe tab offer the same app around them.
 */
export function useTierMode(): ViewMode {
  return useIsDev() ? ViewMode.Dev : UNSTATED_VIEW_MODE;
}

/** Semantic boolean accessor — true only in Vibe mode (the simplest creator skin). */
export function useIsVibe(): boolean {
  return useViewMode() === ViewMode.Vibe;
}

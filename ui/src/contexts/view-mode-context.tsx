import {
  dataContext,
  instancePreferences,
  isHubOnly,
  onPreferenceChange,
  PREF_REGISTRY,
  PrefKey,
  type Project,
} from '@sdk';
import { usePreference, usePreferenceResolved } from '@src/hooks/use-preference';
import { defineGlobal } from '@sdk/utils';
import { useEffect, useSyncExternalStore } from 'react';
import { useCurrentDock } from '@src/navigation/useDockNavigation';

declare global {
  interface Window {
    setView: (val: ViewMode) => void;
    getView: () => ViewMode;
    setDev: (val?: boolean) => void;
    getDev: () => boolean;
  }
}

/**
 * View mode fuses TWO axes on purpose, so one control picks both:
 *  - the session SURFACE — read with `surfaceForViewMode` (vibe workspace / chat
 *    pane / xterm);
 *  - the chrome TIER — read with `isAdvancedMode` (debug toolbars, trace
 *    gutters, `AdvancedOnly`).
 * So `Advanced` means "a terminal AND the full chrome", not just a terminal.
 * Keep that in mind before gating anything new on `isAdvancedMode`: you are
 * attaching it to a surface choice as well as a complexity preference.
 */
export enum ViewMode {
  // Hierarchy (simplest → fullest): Vibe ⊂ Standard ⊂ Advanced ⊂ Dev.
  Vibe = 'vibe',
  Standard = 'standard',
  Advanced = 'advanced',
  Dev = 'dev',
}

// View mode is a *user* preference, now owned by prefMan (`preferences.ui.view_mode`,
// a boot key mirrored to localStorage for instant first paint). It is reflected as a
// `data-view` attribute on the document root so CSS / other surfaces can react app-wide.
// The default mode lives in ONE place: `preferences.ui.view_mode`'s defaultValue
// in prefRegistry.ts. `instancePreferences.get` already resolves an unset key to
// it, and `toViewMode` below derives the same value for unknown/garbage reads —
// so neither restates the product decision. Toggle with window.setView() or the
// footer pill.

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
 * The "advanced-or-fuller" threshold from the mode hierarchy (Advanced ⊂ Dev),
 * as a plain predicate so both the `useIsAdvanced` hook and non-hook callers
 * (e.g. syncDesktopMenu) share one definition of where "advanced" begins.
 */
export function isAdvancedMode(mode: ViewMode): boolean {
  return mode === ViewMode.Advanced || mode === ViewMode.Dev;
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
  return isAdvancedMode(mode) ? 'terminal' : 'chat';
}

/** Transport for a mode: only the terminal surface runs an interactive PTY. */
export function viewModePtyMode(mode: ViewMode): boolean {
  return surfaceForViewMode(mode) === 'terminal';
}

/**
 * Reactive surface, or `null` for NOT KNOWN YET.
 *
 * On the first load in a browser profile there is no localStorage boot seed for
 * `preferences.ui.view_mode`, so `get()` serves the registry default and the
 * session would paint that surface for ~1s until `preferences.json` lands, then
 * repaint into the user's real one. Callers hold the arrangement while this is
 * null instead of painting a guess. After that first load the boot seed makes it
 * true synchronously, so the wait is a first-run cost only.
 *
 * `useViewMode()` deliberately keeps its non-null contract — chrome (isAdvanced
 * &c.) can render against the default and correct itself invisibly. Only the
 * session SURFACE is expensive to get wrong, because it mounts a whole pane.
 */
export function useSessionSurface(): SessionSurface | null {
  const mode = useViewMode();
  const resolved = usePreferenceResolved(PrefKey.VIEW_MODE);
  const currentDock = useCurrentDock();
  const override = useSyncExternalStore(
    subscribeViewModeOverride,
    getViewModeOverrideSnapshot,
    getViewModeOverrideSnapshot,
  );
  // URL-first: after navigation commits, the new dock mode must outrank the
  // passive override left by the previous URL. `useViewMode()` already returns
  // that effective mode synchronously; these two values only certify that it is
  // known even when the persisted preference has not resolved yet.
  if (currentDock?.viewMode || override) return surfaceForViewMode(mode);
  return resolved ? surfaceForViewMode(mode) : null;
}

const viewModeOverrideListeners = new Set<() => void>();
// Since the URL's viewMode is also adopted into the persisted preference on load
// (useDockViewModeOverrideSync), this transient override normally equals the pref.
// Its remaining purpose is to pin the displayed mode against externally-originated
// pref changes (e.g. a cross-device backend reconcile) while a viewMode-carrying
// dock URL is mounted.
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
 * The active mode for non-React callers — the same value `useViewMode()`
 * resolves to, without the hook. Non-component modules (e.g. the `notify()`
 * dispatcher, which gates alert toasts on Dev) must read it through here so
 * they see a dock-URL override, not just the persisted preference.
 */
export function getEffectiveViewMode(): ViewMode {
  return dockViewModeOverride ?? getViewMode();
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

// Mirror the effective view mode to the Electron application menu: it is shown
// only in Advanced/Dev (see electron/main.js `set-menu-visible`). A no-op in the
// browser build (no electronAPI). Keyed on the advanced boolean, not the exact
// mode, so Advanced↔Dev and Vibe↔Standard transitions don't re-send.
let lastMenuVisibleSent: boolean | null = null;
function syncDesktopMenu(val: ViewMode): void {
  const visible = isAdvancedMode(val);
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
  syncDesktopMenu(val);
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

function setDockViewModeOverride(val: ViewMode | null): void {
  if (dockViewModeOverride === val) {
    applyAttribute(getEffectiveViewMode(), false);
    return;
  }
  dockViewModeOverride = val;
  applyAttribute(getEffectiveViewMode());
  viewModeOverrideListeners.forEach((listener) => listener());
}

// One-time migration of the legacy separate `devMode` boolean → viewMode=dev.
if (typeof localStorage !== 'undefined' && localStorage.getItem('devMode') === 'true') {
  localStorage.removeItem('devMode');
  instancePreferences.set(PrefKey.VIEW_MODE, ViewMode.Dev);
}

export function getViewMode(): ViewMode {
  return toViewMode(instancePreferences.get(PrefKey.VIEW_MODE));
}

// Per-project memory: every effective mode change (footer toggle via the dock-URL
// adoption below, pointerless direct set, window.setView/setDev) converges in
// setViewMode, which stamps the current project. The equality guard breaks the
// apply→record feedback loop: applyProjectViewMode → setViewMode(project.last_mode)
// lands here with an already-matching value and no-ops.
function stampProjectViewMode(project: Project | null | undefined, val: ViewMode): void {
  if (!project || project.last_mode === val) return;
  // Hub: view mode is a desk concept — the hub serves one page and its project
  // schema has no `last_mode` to store, so this stamp can only ever be a
  // no-op write. And it isn't harmless: `toJSON` emits only fields the SERVER's
  // schema declares, and the hub publishes just the project-specific delta
  // (artifacts/helpdesk/…) — so the resulting full-row PUT ships without
  // `name` and wipes the name off every project the hub loads, including the
  // one just created. Don't write projects from here on the hub.
  if (isHubOnly()) return;
  project.last_mode = val;
  void project.save().catch((err) => {
    console.warn('[view-mode] failed to record last_mode on project', err);
  });
}

/**
 * Apply a project's remembered view mode on project load (called from
 * `loadProject`, after CurrentProjectTypeId is written to context): a valid
 * stored `last_mode` becomes the active mode; a project without one adopts —
 * and records — the current mode. Saves are fire-and-forget so the loader
 * stays fast (URL-first rule).
 */
export function applyProjectViewMode(project: Project): void {
  const remembered = toViewModeOrNull(project.last_mode);
  if (remembered) {
    setViewMode(remembered);
  } else {
    stampProjectViewMode(project, getViewMode());
  }
}

// The last mode that wasn't Vibe. Entering Vibe ADOPTS it as the persisted
// preference (useDockViewModeOverrideSync), which overwrites whatever the user
// had — so without this latch, an Advanced user who visits Vibe and leaves is
// silently and unrecoverably dropped to Standard (ViewToggle only renders modes
// at or below the current rank, so the Advanced button isn't even on screen).
// Module-scope, session-lived, deliberately not persisted.
let lastNonVibeViewMode: ViewMode | null = null;

function recordNonVibe(val: ViewMode): void {
  if (val !== ViewMode.Vibe) lastNonVibeViewMode = val;
}
recordNonVibe(getViewMode());

/** Where an "exit vibe" affordance should land: the mode in use before Vibe. */
export function previousNonVibeViewMode(): ViewMode {
  return lastNonVibeViewMode ?? ViewMode.Standard;
}

export function setViewMode(val: ViewMode): void {
  recordNonVibe(val);
  instancePreferences.set(PrefKey.VIEW_MODE, val);
  applyAttribute(getEffectiveViewMode());
  stampProjectViewMode(dataContext.project, val);
}

// Keep `data-view` in sync with prefMan: on import (first paint) and on every change,
// including a cross-device backend value reconciled in on load.
applyAttribute(getViewMode(), false);
onPreferenceChange(() => applyAttribute(getEffectiveViewMode()));

defineGlobal('setView', setViewMode);
defineGlobal('getView', getViewMode);

// --- Dev mode globals ---

export function setDev(val?: boolean): void {
  if (val === undefined) {
    // No-arg = toggle: Dev ↔ Advanced
    setViewMode(getViewMode() === ViewMode.Dev ? ViewMode.Advanced : ViewMode.Dev);
  } else if (val) {
    setViewMode(ViewMode.Dev);
  } else {
    setViewMode(ViewMode.Advanced);
  }
}

function getDev(): boolean {
  return getViewMode() === ViewMode.Dev;
}

defineGlobal('setDev', setDev);
defineGlobal('getDev', getDev);

export function useViewMode(): ViewMode {
  const currentDock = useCurrentDock();
  const [value] = usePreference<string>(PrefKey.VIEW_MODE);
  const override = useSyncExternalStore(
    subscribeViewModeOverride,
    getViewModeOverrideSnapshot,
    getViewModeOverrideSnapshot,
  );
  // URL-first: a committed dock URL is authoritative immediately. The
  // transient override and persisted preference are projections adopted by a
  // later effect; using them first creates a render where the toggle, session
  // skin, and transport reconciler can all observe the previous mode.
  const mode = currentDock?.viewMode ?? override ?? toViewMode(value);
  useEffect(() => applyAttribute(mode), [mode]);
  return mode;
}

/**
 * Sync the current DockPointer's viewMode override into useViewMode().
 * This is the load-time owner of all view-mode arrangements: the footer toggle
 * only navigates (same pointer, `?viewMode=<mode>`); when the URL loads here we
 * apply the mode AND adopt it as the persisted preference, so the choice
 * survives leaving the URL and the session without any write in the click path.
 */
export function useDockViewModeOverrideSync(): void {
  const currentDock = useCurrentDock();
  const override = currentDock?.viewMode ?? null;

  useEffect(() => {
    setDockViewModeOverride(override);
    // instancePreferences.set no-ops on equal values, so no guard is needed here.
    if (override) setViewMode(override);
  }, [override]);

  useEffect(() => () => setDockViewModeOverride(null), []);
}

/** Semantic boolean accessor — true if Advanced or Dev (hierarchy). */
export function useIsAdvanced(): boolean {
  return isAdvancedMode(useViewMode());
}

/** Semantic boolean accessor — true only in Dev mode. */
export function useIsDev(): boolean {
  return useViewMode() === ViewMode.Dev;
}

/** Semantic boolean accessor — true only in Vibe mode (the simplest creator skin). */
export function useIsVibe(): boolean {
  return useViewMode() === ViewMode.Vibe;
}

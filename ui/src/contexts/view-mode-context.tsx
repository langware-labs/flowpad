import { dataContext, instancePreferences, onPreferenceChange, PREF_REGISTRY, PrefKey, type Project } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
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

function getEffectiveViewMode(): ViewMode {
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

function applyAttribute(val: ViewMode, animate = true): void {
  if (val === ViewMode.Vibe) ensureVibeFont();
  const prev = document.documentElement.getAttribute('data-view');
  // Guard: prefMan fires on EVERY pref change, but only a view-mode change need
  // touch the DOM. Skip the write when the attribute already matches.
  if (prev !== val) {
    document.documentElement.setAttribute('data-view', val);
    if (animate && prev != null) {
      document.documentElement.classList.remove('view-mode-glow-flicker');
      // Restart the CSS animation even when changes happen in quick succession.
      void document.documentElement.offsetWidth;
      document.documentElement.classList.add('view-mode-glow-flicker');
      if (flickerTimer !== undefined) window.clearTimeout(flickerTimer);
      flickerTimer = window.setTimeout(() => {
        document.documentElement.classList.remove('view-mode-glow-flicker');
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

export function setViewMode(val: ViewMode): void {
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
  const [value] = usePreference<string>(PrefKey.VIEW_MODE);
  const override = useSyncExternalStore(
    subscribeViewModeOverride,
    getViewModeOverrideSnapshot,
    getViewModeOverrideSnapshot,
  );
  const mode = override ?? toViewMode(value);
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
  const mode = useViewMode();
  return mode === ViewMode.Advanced || mode === ViewMode.Dev;
}

/** Semantic boolean accessor — true only in Dev mode. */
export function useIsDev(): boolean {
  return useViewMode() === ViewMode.Dev;
}

/** Semantic boolean accessor — true only in Vibe mode (the simplest creator skin). */
export function useIsVibe(): boolean {
  return useViewMode() === ViewMode.Vibe;
}

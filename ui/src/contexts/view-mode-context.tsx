import { instancePreferences, onPreferenceChange, PrefKey } from '@sdk';
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
// Default is Standard (the calm/minimal app); Vibe (super-simple, Lovable-style
// creator UI) is opt-in via the footer View toggle; opt up to Advanced; Dev for
// developers. The default lives in `preferences.ui.view_mode` (prefRegistry.ts,
// defaultValue 'standard') — `toViewMode` below falls back to Standard for any
// unset/unknown value. Toggle with window.setView() or the footer pill.

function toViewMode(v: unknown): ViewMode {
  return v === ViewMode.Advanced || v === ViewMode.Dev || v === ViewMode.Vibe
    ? (v as ViewMode)
    : ViewMode.Standard;
}

const viewModeOverrideListeners = new Set<() => void>();
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

// Vibe's display font (Plus Jakarta Sans) is loaded lazily — and only the first
// time Vibe is actually active — so Standard/Advanced/Dev users (the majority,
// who never see it) don't pay a render-blocking cross-origin font fetch on boot.
// A global CSS @import would block first paint for everyone.
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

export function setViewMode(val: ViewMode): void {
  instancePreferences.set(PrefKey.VIEW_MODE, val);
  applyAttribute(getEffectiveViewMode());
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

/** Sync the current DockPointer's page-local viewMode override into useViewMode(). */
export function useDockViewModeOverrideSync(): void {
  const currentDock = useCurrentDock();
  const override = currentDock?.viewMode ?? null;

  useEffect(() => {
    setDockViewModeOverride(override);
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

import { instancePreferences, onPreferenceChange, PrefKey } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { defineGlobal } from '@sdk/utils';

declare global {
  interface Window {
    setView: (val: ViewMode) => void;
    getView: () => ViewMode;
    setDev: (val?: boolean) => void;
    getDev: () => boolean;
  }
}

export enum ViewMode {
  Standard = 'standard',
  Advanced = 'advanced',
  Dev = 'dev',
}

// View mode is a *user* preference, now owned by prefMan (`preferences.ui.view_mode`,
// a boot key mirrored to localStorage for instant first paint). It is reflected as a
// `data-view` attribute on the document root so CSS / other surfaces can react app-wide.
// Default Standard (calm/minimal); opt up to Advanced; Dev for developers. Toggle with
// window.setView() or the footer pill.

function toViewMode(v: unknown): ViewMode {
  return v === ViewMode.Advanced || v === ViewMode.Dev ? (v as ViewMode) : ViewMode.Standard;
}

function applyAttribute(val: ViewMode): void {
  // Guard: prefMan fires on EVERY pref change, but only a view-mode change need
  // touch the DOM. Skip the write when the attribute already matches.
  if (document.documentElement.getAttribute('data-view') !== val) {
    document.documentElement.setAttribute('data-view', val);
  }
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
  applyAttribute(val);
}

// Keep `data-view` in sync with prefMan: on import (first paint) and on every change,
// including a cross-device backend value reconciled in on load.
applyAttribute(getViewMode());
onPreferenceChange(() => applyAttribute(getViewMode()));

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
  return toViewMode(value);
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

import { useEffect, useState } from 'react';
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

const VIEW_MODE_KEY = 'viewMode';

// View mode is a *user* toggle persisted in localStorage. It is NOT inherited
// from any build-time constant. Like the theme, it is also reflected as a
// `data-view` attribute on the document root so CSS / other surfaces can react
// to it app-wide. Default is Standard so new users start on the calm/minimal
// surface and opt up to Advanced. Developers can toggle into Dev. Toggle with
// window.setView() or the footer pill. Legacy devMode boolean is migrated here.
function readInitial(): ViewMode {
  // Migration: old system used separate localStorage.devMode boolean
  const legacyDev = localStorage.getItem('devMode');
  if (legacyDev === 'true') {
    localStorage.removeItem('devMode');
    localStorage.setItem(VIEW_MODE_KEY, ViewMode.Dev);
    return ViewMode.Dev;
  }

  const stored = localStorage.getItem(VIEW_MODE_KEY);
  return stored === ViewMode.Standard || stored === ViewMode.Advanced || stored === ViewMode.Dev
    ? (stored as ViewMode)
    : ViewMode.Standard;
}

let _mode: ViewMode = readInitial();
const _listeners = new Set<(val: ViewMode) => void>();

function applyAttribute(val: ViewMode): void {
  document.documentElement.setAttribute('data-view', val);
}

// Apply on import so the attribute is present on first paint.
applyAttribute(_mode);

export function setViewMode(val: ViewMode): void {
  _mode = val;
  localStorage.setItem(VIEW_MODE_KEY, val);
  applyAttribute(val);
  _listeners.forEach((fn) => fn(val));
}

export function getViewMode(): ViewMode {
  return _mode;
}

defineGlobal('setView', setViewMode);
defineGlobal('getView', getViewMode);

// --- Dev mode globals (overrides any shim registration) ---

function setDev(val?: boolean): void {
  if (val === undefined) {
    // No-arg = toggle: Dev ↔ Advanced
    setViewMode(_mode === ViewMode.Dev ? ViewMode.Advanced : ViewMode.Dev);
  } else if (val) {
    setViewMode(ViewMode.Dev);
  } else {
    setViewMode(ViewMode.Advanced);
  }
}

function getDev(): boolean {
  return _mode === ViewMode.Dev;
}

defineGlobal('setDev', setDev);
defineGlobal('getDev', getDev);

export function useViewMode(): ViewMode {
  const [mode, setModeState] = useState(_mode);

  useEffect(() => {
    _listeners.add(setModeState);
    return () => {
      _listeners.delete(setModeState);
    };
  }, []);

  return mode;
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

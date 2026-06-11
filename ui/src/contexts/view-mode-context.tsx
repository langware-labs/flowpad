import { useEffect, useState } from 'react';
import { defineGlobal } from '@sdk/utils';

declare global {
  interface Window {
    setView: (val: ViewMode) => void;
    getView: () => ViewMode;
  }
}

export enum ViewMode {
  Standard = 'standard',
  Advanced = 'advanced',
}

const VIEW_MODE_KEY = 'viewMode';

// View mode is a *user* toggle persisted in localStorage, mirroring the
// dev-mode flag. It is NOT inherited from any build-time constant. Like the
// theme, it is also reflected as a `data-view` attribute on the document root
// so CSS / other surfaces can react to it app-wide. Default is Standard so new
// users start on the calm/minimal surface and opt up to Advanced. Toggle with
// window.setView() or the footer pill.
function readInitial(): ViewMode {
  const stored = localStorage.getItem(VIEW_MODE_KEY);
  return stored === ViewMode.Standard || stored === ViewMode.Advanced
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

/** Semantic boolean accessor — mirrors useDevMode()'s shape. */
export function useIsAdvanced(): boolean {
  return useViewMode() === ViewMode.Advanced;
}

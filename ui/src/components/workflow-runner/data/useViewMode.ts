/**
 * Simple vs expert view mode. URL ?view=simple|expert; falls back to
 * session-storage on first load so the toggle "sticks" within a tab.
 */

import { useCallback, useEffect, useState } from 'react';

import type { ViewMode } from './types';

const QS_KEY = 'view';
const SESSION_KEY = 'workflowRunner.viewMode';

function normalize(raw: unknown): ViewMode | null {
  if (raw === 'simple' || raw === 'expert') return raw;
  return null;
}

function readUrl(): ViewMode | null {
  if (typeof window === 'undefined') return null;
  return normalize(new URLSearchParams(window.location.search).get(QS_KEY));
}

function readSession(): ViewMode | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalize(window.sessionStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function writeUrl(mode: ViewMode) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  params.set(QS_KEY, mode);
  const qs = params.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState(window.history.state, '', url);
}

function writeSession(mode: ViewMode) {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SESSION_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function useViewMode(): {
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  toggleViewMode: () => void;
} {
  const [viewMode, setMode] = useState<ViewMode>(
    () => readUrl() ?? readSession() ?? 'simple',
  );

  useEffect(() => {
    writeUrl(viewMode);
    writeSession(viewMode);
  }, [viewMode]);

  useEffect(() => {
    const onPop = () => {
      const next = readUrl();
      if (next) setMode(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const setViewMode = useCallback((m: ViewMode) => setMode(m), []);
  const toggleViewMode = useCallback(
    () => setMode((m) => (m === 'simple' ? 'expert' : 'simple')),
    [],
  );

  return { viewMode, setViewMode, toggleViewMode };
}

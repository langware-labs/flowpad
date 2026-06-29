/**
 * Selected step line — backed by the URL hash (`#step=L12`).
 *
 * Survives reload. Sync direction: hash → state on mount + popstate;
 * state → hash via `replaceState` (avoids polluting the history stack).
 */

import { useCallback, useEffect, useState } from 'react';

const HASH_KEY = 'step';

function readHash(): number | null {
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const v = params.get(HASH_KEY);
  if (!v) return null;
  const m = v.match(/^L?(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function writeHash(line: number | null) {
  if (typeof window === 'undefined') return;
  const raw = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(raw);
  if (line == null) {
    params.delete(HASH_KEY);
  } else {
    params.set(HASH_KEY, `L${line}`);
  }
  const nextHash = params.toString();
  const url = `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`;
  window.history.replaceState(window.history.state, '', url);
}

export interface UseStepSelectionResult {
  selectedLine: number | null;
  selectStep: (line: number | null) => void;
  /** Toggle: if `line` is already selected, clear; otherwise select. */
  toggleStep: (line: number) => void;
}

export function useStepSelection(): UseStepSelectionResult {
  const [selectedLine, setSelectedLine] = useState<number | null>(() => readHash());

  // Sync hash → state on browser back/forward.
  useEffect(() => {
    const onPop = () => setSelectedLine(readHash());
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onPop);
    };
  }, []);

  // Sync state → hash.
  useEffect(() => {
    writeHash(selectedLine);
  }, [selectedLine]);

  const selectStep = useCallback((line: number | null) => {
    setSelectedLine(line);
  }, []);

  const toggleStep = useCallback((line: number) => {
    setSelectedLine((prev) => (prev === line ? null : line));
  }, []);

  return { selectedLine, selectStep, toggleStep };
}

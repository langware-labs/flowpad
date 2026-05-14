/**
 * Run selection state — URL-backed (`?runs=da21bea1,468f5570`).
 *
 * Conventions:
 *  - first id in the list = active run
 *  - any extra ids = comparison runs (overlay)
 *  - empty list = default to runs[0]
 *
 * Survives reload via URLSearchParams; pushState avoided to keep
 * navigation history clean — replaceState only.
 */

import { useCallback, useEffect, useState } from 'react';

const QS_KEY = 'runs';

function readSelection(): string[] {
  if (typeof window === 'undefined') return [];
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(QS_KEY);
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function writeSelection(ids: string[]) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (ids.length === 0) {
    params.delete(QS_KEY);
  } else {
    params.set(QS_KEY, ids.join(','));
  }
  const qs = params.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState(window.history.state, '', url);
}

export interface UseRunSelectionResult {
  /** First id = active. */
  selectedIds: string[];
  /** Set as the only selected run (clears overlay). */
  selectRun: (id: string) => void;
  /** Add (or move to active) / remove a run from the overlay. */
  toggleOverlay: (id: string) => void;
  /** Replace the entire selection. */
  setOverlay: (ids: string[]) => void;
}

/**
 * @param availableIds  All run IDs in the order the strip displays (newest-first).
 *                      Used to pick the default when the URL is empty.
 */
export function useRunSelection(availableIds: string[]): UseRunSelectionResult {
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    const fromUrl = readSelection();
    if (fromUrl.length > 0) return fromUrl;
    return availableIds.length > 0 ? [availableIds[0]] : [];
  });

  // When the available set changes (e.g. a new run lands) and the user has no
  // explicit URL selection, default to the newest.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const urlIds = readSelection();
    if (urlIds.length > 0) {
      // Trust URL — drop any ids no longer in the available set.
      const kept = urlIds.filter((id) => availableIds.includes(id));
      if (kept.length === 0 && availableIds.length > 0) {
        setSelectedIds([availableIds[0]]);
      } else if (kept.length !== urlIds.length) {
        setSelectedIds(kept);
      }
      return;
    }
    if (availableIds.length > 0 && selectedIds.length === 0) {
      setSelectedIds([availableIds[0]]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableIds.join(',')]);

  // Sync state → URL.
  useEffect(() => {
    writeSelection(selectedIds);
  }, [selectedIds]);

  // Sync URL → state on back/forward.
  useEffect(() => {
    const onPop = () => setSelectedIds(readSelection());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const selectRun = useCallback((id: string) => {
    setSelectedIds([id]);
  }, []);

  const toggleOverlay = useCallback((id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((x) => x !== id);
        return next.length > 0 ? next : prev; // never empty
      }
      return [...prev, id];
    });
  }, []);

  const setOverlay = useCallback((ids: string[]) => {
    setSelectedIds(ids.length > 0 ? ids : []);
  }, []);

  return { selectedIds, selectRun, toggleOverlay, setOverlay };
}

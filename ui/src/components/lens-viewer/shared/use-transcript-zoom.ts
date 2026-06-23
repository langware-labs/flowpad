import { useCallback } from 'react';

import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { patchTranscriptDockOptions } from './transcript-dock-options';

const URL_PARAM = 'zoom';

export type ZoomWindow = [number, number];

/** Decode `?zoom=<a>-<b>` (absolute epoch ms) to a window, or null if absent/malformed. */
function decodeZoom(value: string | undefined): ZoomWindow | null {
  if (!value) return null;
  const m = /^(\d+)-(\d+)$/.exec(value);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : null;
}

/**
 * URL-backed zoom window for the Call-stack timeline. Reads `?zoom=<a>-<b>`
 * (absolute ms) from the current dock; setting it pushes a new DockPointer so
 * the zoom is shareable and browser back/forward step through zoom states.
 * Mirrors {@link useTranscriptMode} — the URL is the single source of truth.
 */
export function useTranscriptZoom() {
  const { navigation, currentDock } = useDockNavigation();
  const zoom = decodeZoom(currentDock?.options?.[URL_PARAM]);

  const setZoom = useCallback(
    (z: ZoomWindow | null) => {
      patchTranscriptDockOptions(navigation, currentDock, {
        [URL_PARAM]: z ? `${Math.round(z[0])}-${Math.round(z[1])}` : undefined,
      });
    },
    [navigation, currentDock],
  );

  return [zoom, setZoom] as const;
}

import { useCallback, useState } from 'react';

import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

export type TranscriptMode = 'chat' | 'trace';

const STORAGE_KEY = 'transcript-viewer-mode';
const URL_PARAM = 'transcriptMode';
const DEFAULT_MODE: TranscriptMode = 'chat';

function readStored(): TranscriptMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'chat' || raw === 'trace') return raw;
    // Backward-compat: prior value 'transcript' maps to new 'trace' name.
    if (raw === 'transcript') return 'trace';
    return DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

function isTranscriptMode(value: string | undefined | null): value is TranscriptMode {
  return value === 'chat' || value === 'trace';
}

/**
 * View-mode preference for transcript viewers. Source-of-truth precedence:
 *   1. URL query `?transcriptMode=chat|trace` (when mounted under a DockPointer)
 *   2. localStorage `transcript-viewer-mode` (legacy 'transcript' value mapped to 'trace')
 *   3. 'chat' (default)
 *
 * Setting the mode pushes a new DockPointer with the option merged in, so the
 * URL is shareable + back-button-restorable, matching ?editorMode and ?runId
 * on the workflow editor surface. localStorage is mirrored so links without
 * the query param keep the user's last choice.
 */
export function useTranscriptMode() {
  const { navigation, currentDock } = useDockNavigation();
  const urlMode = currentDock?.options?.[URL_PARAM];
  const [localMode, setLocalMode] = useState<TranscriptMode>(readStored);
  const mode: TranscriptMode = isTranscriptMode(urlMode) ? urlMode : localMode;

  const setMode = useCallback(
    (m: TranscriptMode) => {
      setLocalMode(m);
      try {
        localStorage.setItem(STORAGE_KEY, m);
      } catch {
        /* storage may be disabled */
      }
      if (currentDock) {
        const nextOptions = { ...(currentDock.options ?? {}), [URL_PARAM]: m };
        navigation.openDock(
          new DockPointer(currentDock.viewType, currentDock.pointer, nextOptions, currentDock.layout),
        );
      }
    },
    [currentDock, navigation],
  );

  return [mode, setMode] as const;
}

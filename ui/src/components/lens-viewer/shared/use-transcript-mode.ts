import { useCallback, useState } from 'react';

import { useIsAdvanced } from '@src/components/view-mode';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { patchTranscriptDockOptions } from './transcript-dock-options';

export type TranscriptMode = 'chat' | 'trace' | 'callstack' | 'execution';

const STORAGE_KEY = 'transcript-viewer-mode';
const URL_PARAM = 'transcriptMode';
const DEFAULT_MODE: TranscriptMode = 'chat';

/** Resolve a raw URL/stored value to a mode, mapping legacy aliases. */
function normalizeMode(value: string | undefined | null): TranscriptMode | undefined {
  // Legacy alias: 'transcript' → 'trace'.
  if (value === 'transcript') return 'trace';
  return value === 'chat' || value === 'trace' || value === 'callstack' || value === 'execution'
    ? value
    : undefined;
}

function readStored(): TranscriptMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  try {
    return normalizeMode(localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
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
 *
 * Standard view sees the plain chat view only — the trace / callstack / execution
 * modes belong to Advanced/Dev. The read path is forced to 'chat' when not
 * advanced; the persisted preference is left untouched (skin-layer rule), so it
 * returns when the user switches up to Advanced.
 */
export function useTranscriptMode() {
  const { navigation, currentDock } = useDockNavigation();
  const isAdvanced = useIsAdvanced();
  const urlMode = normalizeMode(currentDock?.options?.[URL_PARAM]);
  const [localMode, setLocalMode] = useState<TranscriptMode>(readStored);
  const mode: TranscriptMode = isAdvanced ? (urlMode ?? localMode) : 'chat';

  const setMode = useCallback(
    (m: TranscriptMode) => {
      setLocalMode(m);
      try {
        localStorage.setItem(STORAGE_KEY, m);
      } catch {
        /* storage may be disabled */
      }
      patchTranscriptDockOptions(navigation, currentDock, { [URL_PARAM]: m });
    },
    [currentDock, navigation],
  );

  return [mode, setMode] as const;
}

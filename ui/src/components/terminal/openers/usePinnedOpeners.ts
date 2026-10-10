import { useCallback } from 'react';
import { PrefKey } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import type { ViewMode } from '@src/contexts/view-mode-context';
import { type OpenerId } from './tab_opener_types';

export interface UsePinnedOpenersResult {
  pinned: OpenerId[];
  lastOpened: OpenerId | null;
  /** The view mode the last launch opened in — the "shape" the quick-launch slot reproduces. */
  lastMode: ViewMode | null;
  isPinned: (id: OpenerId) => boolean;
  togglePin: (id: OpenerId) => void;
}

export function usePinnedOpeners(): UsePinnedOpenersResult {
  const [pinned, setPinned] = usePreference<OpenerId[]>(PrefKey.PINNED_OPENERS);
  const [lastOpened] = usePreference<OpenerId | null>(PrefKey.LAST_OPENER);
  const [lastMode] = usePreference<ViewMode | null>(PrefKey.LAST_OPENER_MODE);

  const isPinned = useCallback((id: OpenerId) => pinned.includes(id), [pinned]);

  const togglePin = useCallback(
    (id: OpenerId) => {
      setPinned(pinned.includes(id) ? pinned.filter((v) => v !== id) : [...pinned, id]);
    },
    [pinned, setPinned],
  );

  return {
    pinned,
    lastOpened,
    lastMode,
    isPinned,
    togglePin,
  };
}

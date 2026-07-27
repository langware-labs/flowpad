import { useCallback } from 'react';
import { PrefKey } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { type OpenerId } from './tab_opener_types';

export interface UsePinnedOpenersResult {
  pinned: OpenerId[];
  lastOpened: OpenerId | null;
  isPinned: (id: OpenerId) => boolean;
  togglePin: (id: OpenerId) => void;
  rememberOpened: (id: OpenerId) => void;
}

export function usePinnedOpeners(): UsePinnedOpenersResult {
  const [pinned, setPinned] = usePreference<OpenerId[]>(PrefKey.PINNED_OPENERS);
  const [lastOpened, setLastOpened] = usePreference<OpenerId | null>(PrefKey.LAST_OPENER);

  const isPinned = useCallback((id: OpenerId) => pinned.includes(id), [pinned]);

  const togglePin = useCallback(
    (id: OpenerId) => {
      setPinned(pinned.includes(id) ? pinned.filter((v) => v !== id) : [...pinned, id]);
    },
    [pinned, setPinned],
  );

  const rememberOpened = useCallback(
    (id: OpenerId) => {
      setLastOpened(id);
    },
    [setLastOpened],
  );

  return {
    pinned,
    lastOpened,
    isPinned,
    togglePin,
    rememberOpened,
  };
}

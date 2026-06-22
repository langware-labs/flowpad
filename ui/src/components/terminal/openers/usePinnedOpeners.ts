import { useCallback, useEffect, useState } from 'react';
import { VALID_OPENER_IDS, type OpenerId } from './tab_opener_types';
import { readLastOpenerId, subscribeLastOpener, writeLastOpenerId } from './useLastWorkerType';

const STORAGE_KEY = 'flowpad.terminal.pinnedOpeners';

function isValidOpenerId(value: unknown): value is OpenerId {
  return typeof value === 'string' && (VALID_OPENER_IDS as string[]).includes(value);
}

function readFromStorage(): OpenerId[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidOpenerId);
  } catch {
    return [];
  }
}

export interface UsePinnedOpenersResult {
  pinned: OpenerId[];
  lastOpened: OpenerId | null;
  isPinned: (id: OpenerId) => boolean;
  togglePin: (id: OpenerId) => void;
  rememberOpened: (id: OpenerId) => void;
}

export function usePinnedOpeners(): UsePinnedOpenersResult {
  const [pinned, setPinned] = useState<OpenerId[]>(() => readFromStorage());
  const [lastOpened, setLastOpened] = useState<OpenerId | null>(() => readLastOpenerId());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pinned));
    } catch {
      // Ignore storage failures (private mode, quota exceeded)
    }
  }, [pinned]);

  // Stay in sync when another surface (e.g. WorkerToolbar) writes the shared key.
  useEffect(() => subscribeLastOpener(() => setLastOpened(readLastOpenerId())), []);

  const isPinned = useCallback((id: OpenerId) => pinned.includes(id), [pinned]);

  const togglePin = useCallback((id: OpenerId) => {
    setPinned((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }, []);

  const rememberOpened = useCallback((id: OpenerId) => {
    setLastOpened(id);
    writeLastOpenerId(id);
  }, []);

  return {
    pinned,
    lastOpened,
    isPinned,
    togglePin,
    rememberOpened,
  };
}

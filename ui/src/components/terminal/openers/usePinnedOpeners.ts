import { useCallback, useEffect, useState } from 'react';
import type { OpenerId } from './tab_opener_types';

const STORAGE_KEY = 'flowpad.terminal.pinnedOpeners';

const VALID_IDS: OpenerId[] = ['claude', 'claude-resume-by-id', 'terminal', 'sandbox', 'docker', 'history'];

function readFromStorage(): OpenerId[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is OpenerId => typeof v === 'string' && (VALID_IDS as string[]).includes(v));
  } catch {
    return [];
  }
}

export interface UsePinnedOpenersResult {
  pinned: OpenerId[];
  isPinned: (id: OpenerId) => boolean;
  togglePin: (id: OpenerId) => void;
  shouldAutoPinNext: boolean;
}

export function usePinnedOpeners(): UsePinnedOpenersResult {
  const [pinned, setPinned] = useState<OpenerId[]>(() => readFromStorage());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pinned));
    } catch {
      // Ignore storage failures (private mode, quota exceeded)
    }
  }, [pinned]);

  const isPinned = useCallback((id: OpenerId) => pinned.includes(id), [pinned]);

  const togglePin = useCallback((id: OpenerId) => {
    setPinned((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }, []);

  return {
    pinned,
    isPinned,
    togglePin,
    shouldAutoPinNext: pinned.length === 0,
  };
}

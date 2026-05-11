import { useCallback, useEffect, useState } from 'react';
import type { OpenerId } from './tab_opener_types';

const STORAGE_KEY = 'flowpad.terminal.pinnedOpeners';
const LAST_OPENER_STORAGE_KEY = 'flowpad.terminal.lastOpener';

const VALID_IDS: OpenerId[] = ['claude', 'codex', 'claude-resume-by-id', 'terminal', 'sandbox', 'docker', 'history'];

function isValidOpenerId(value: unknown): value is OpenerId {
  return typeof value === 'string' && (VALID_IDS as string[]).includes(value);
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

function readLastOpenerFromStorage(): OpenerId | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(LAST_OPENER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidOpenerId(parsed) ? parsed : null;
  } catch {
    return null;
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
  const [lastOpened, setLastOpened] = useState<OpenerId | null>(() => readLastOpenerFromStorage());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pinned));
    } catch {
      // Ignore storage failures (private mode, quota exceeded)
    }
  }, [pinned]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (lastOpened) {
        window.localStorage.setItem(LAST_OPENER_STORAGE_KEY, JSON.stringify(lastOpened));
      } else {
        window.localStorage.removeItem(LAST_OPENER_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures (private mode, quota exceeded)
    }
  }, [lastOpened]);

  const isPinned = useCallback((id: OpenerId) => pinned.includes(id), [pinned]);

  const togglePin = useCallback((id: OpenerId) => {
    setPinned((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  }, []);

  const rememberOpened = useCallback((id: OpenerId) => {
    setLastOpened(id);
  }, []);

  return {
    pinned,
    lastOpened,
    isPinned,
    togglePin,
    rememberOpened,
  };
}

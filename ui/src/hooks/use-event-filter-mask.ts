import { useCallback, useEffect, useState } from 'react';

export type FilterMask = Record<string, string>;

const STORAGE_KEY = 'flowpad-sniffer-filter-mask';

function loadMask(): FilterMask {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  return {};
}

function saveMask(mask: FilterMask): void {
  try {
    if (Object.keys(mask).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mask));
    }
  } catch {
    // ignore
  }
}

export function useEventFilterMask() {
  const [mask, setMask] = useState<FilterMask>(loadMask);

  // Cross-tab sync via storage event
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setMask(loadMask());
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const setFilter = useCallback((key: string, value: string) => {
    setMask((prev) => {
      // Toggle: if same key+value already set, remove it
      if (prev[key] === value) {
        const next = { ...prev };
        delete next[key];
        saveMask(next);
        return next;
      }
      const next = { ...prev, [key]: value };
      saveMask(next);
      return next;
    });
  }, []);

  const removeFilter = useCallback((key: string) => {
    setMask((prev) => {
      const next = { ...prev };
      delete next[key];
      saveMask(next);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    saveMask({});
    setMask({});
  }, []);

  return {
    mask,
    setFilter,
    removeFilter,
    clearAll,
    maskSize: Object.keys(mask).length,
  };
}

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'oauth-connection-timestamps';

/**
 * Remembers when each provider was connected, so the row can say "3 minutes ago".
 *
 * This used to read `localStorage` in a lazy initializer and never write back,
 * so the map was permanently `{}` and the relative-time label could not render.
 * The write is the whole point of the hook.
 *
 * Purely cosmetic: the backend does not record a connection time, and losing
 * this map costs nothing but the label.
 */
export function useConnectionTimestamps() {
  const [timestamps, setTimestamps] = useState<Record<string, Date>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return {};
      const parsed = JSON.parse(saved) as Record<string, string>;
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, new Date(v)]));
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(timestamps));
    } catch {
      /* a full or unavailable quota costs only the label */
    }
  }, [timestamps]);

  const record = useCallback((connectionId: string) => {
    setTimestamps((prev) => ({ ...prev, [connectionId]: new Date() }));
  }, []);

  const forget = useCallback((connectionId: string) => {
    setTimestamps((prev) => {
      const next = { ...prev };
      delete next[connectionId];
      return next;
    });
  }, []);

  return { timestamps, record, forget } as const;
}

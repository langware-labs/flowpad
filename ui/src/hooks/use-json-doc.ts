import { useEffect, useState } from 'react';
import { FSRef } from '@sdk';

/**
 * Loads + parses the JSON document behind a file-backed entity (agent trace,
 * usage report, cleanup report, …). Payloads can be several MB, so the file is
 * read once per fsRef path and cached in state — re-renders never re-read.
 */
export function useJsonDoc<T>(fsRef: FSRef | null): {
  doc: T | null;
  error: string | null;
  loading: boolean;
} {
  const [doc, setDoc] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = fsRef?.path ?? null;

  useEffect(() => {
    setDoc(null);
    setError(null);
    if (!fsRef) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = await fsRef.read();
        if (cancelled) return;
        setDoc(JSON.parse(raw) as T);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return { doc, error, loading: !!path && !doc && !error };
}

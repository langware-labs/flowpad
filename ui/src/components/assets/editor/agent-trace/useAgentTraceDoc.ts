import { useEffect, useState } from 'react';
import { FSRef } from '@sdk';
import type { AgentTraceDoc } from './trace-types';

/**
 * Loads + parses the trace.json behind an AgentTrace entity. The payload can
 * be several MB for team sessions, so it's read once per fsRef and cached in
 * state — timeline seeks never re-read or re-parse.
 */
export function useAgentTraceDoc(fsRef: FSRef | null): {
  doc: AgentTraceDoc | null;
  error: string | null;
  loading: boolean;
} {
  const [doc, setDoc] = useState<AgentTraceDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = fsRef?.path ?? null;

  useEffect(() => {
    if (!fsRef) return;
    let cancelled = false;
    setDoc(null);
    setError(null);
    (async () => {
      try {
        const raw = await fsRef.read();
        if (cancelled) return;
        setDoc(JSON.parse(raw) as AgentTraceDoc);
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

  return { doc, error, loading: !doc && !error };
}

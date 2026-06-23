import { useEffect, useState } from 'react';
import { sdkConfig } from '@sdk/config/index';
import type { AgentTraceDoc } from './trace-types';

interface UseTraceSkeletonReturn {
  skeleton: AgentTraceDoc | null;
  error: string | null;
  loading: boolean;
}

/**
 * Fetch the **deterministic** AgentTrace skeleton for a worker session —
 * lanes, segments, call_tree, timings, costs and tool failures, synthesized
 * server-side straight from the transcript. No agent-trace skill run required:
 * this is the call stack itself; only goals/verdict/divergence *annotations*
 * need the skill (and arrive via an AgentTrace entity).
 *
 * Mirrors {@link useTranscript}'s data path for the same `/api/v1/workers/...`
 * route family (raw fetch against the bootstrapped `sdkConfig.apiUrl`, reading
 * the route's `{ok, skeleton}` shape). Re-fetches on workerType/sessionId.
 */
export function useTraceSkeleton(
  workerType: string | null,
  sessionId: string | null,
): UseTraceSkeletonReturn {
  const [skeleton, setSkeleton] = useState<AgentTraceDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!workerType || !sessionId) {
      setSkeleton(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setSkeleton(null);
    setError(null);
    setLoading(true);
    const url =
      `${sdkConfig.apiUrl}/api/v1/workers/${encodeURIComponent(workerType)}` +
      `/${encodeURIComponent(sessionId)}/trace-skeleton`;
    fetch(url, { credentials: 'include' })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok || json?.ok === false) {
          const code = json?.error_code ?? r.status;
          const msg = json?.error ?? r.statusText;
          throw new Error(`${code}: ${msg}`);
        }
        return json.skeleton as AgentTraceDoc;
      })
      .then((doc) => {
        if (cancelled) return;
        setSkeleton(doc);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workerType, sessionId]);

  return { skeleton, error, loading };
}

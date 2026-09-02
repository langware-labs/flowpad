import { useEffect, useState } from 'react';
import apiClient from '@sdk/client';
import { describeApiError } from '@src/lib/error-message';
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
 * route family (`apiClient`, which unwraps the `{status, data}` envelope to
 * the route's `{skeleton}` payload). Re-fetches on workerType/sessionId.
 */
export function useTraceSkeleton(workerType: string | null, sessionId: string | null): UseTraceSkeletonReturn {
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
    const path =
      `/api/v1/workers/${encodeURIComponent(workerType)}` + `/${encodeURIComponent(sessionId)}/trace-skeleton`;
    apiClient
      .get<{ skeleton: AgentTraceDoc }>(path)
      .then((json) => json.skeleton)
      .then((doc) => {
        if (cancelled) return;
        setSkeleton(doc);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const { code, message } = describeApiError(e);
        setError(`${code}: ${message}`);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workerType, sessionId]);

  return { skeleton, error, loading };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { sdkConfig } from '@sdk/config/index';
import {
  parseTranscriptResponse,
  type ParsedTranscript,
} from '@sdk/utils/agent-transcript';

/**
 * Worker types the generic transcript viewer supports. Mirrors the server
 * route's whitelist in `flow_sdk/server/routes/transcripts.py`.
 */
export type WorkerType = 'claude' | 'codex';

interface UseTranscriptArgs {
  workerType: WorkerType;
  /** Absolute filesystem path to the JSONL transcript. Provide this OR sessionId. */
  path?: string;
  /** Session id; the server resolves the on-disk JSONL via the worker route. */
  sessionId?: string;
}

interface UseTranscriptReturn {
  data: ParsedTranscript | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Fetch and parse a worker transcript via the generic backend route.
 *
 * The hook is the single data path used by `GenericTranscriptViewer`.
 * Server-side `AgentTranscriptFile(worker_type, path)` parses the JSONL and
 * returns typed entries; we just hand the JSON to `parseTranscriptResponse`
 * for runtime validation. Re-fetches when `workerType` or `path` changes.
 */
export function useTranscript({ workerType, path, sessionId }: UseTranscriptArgs): UseTranscriptReturn {
  const [data, setData] = useState<ParsedTranscript | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Bumped by `refetch()` to force a re-run of the loading effect.
  const [reloadToken, setReloadToken] = useState(0);
  // Track in-flight requests so a fast workerType/path swap doesn't race.
  const cancelRef = useRef(0);

  useEffect(() => {
    if (!workerType || (!path && !sessionId)) {
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    const myToken = ++cancelRef.current;

    // Prefer sessionId form (server resolves the JSONL — no client-side path
    // encoding required, fixes the project_encoded_name divergence bug).
    const url = sessionId
      ? `${sdkConfig.apiUrl}/api/v1/workers/${encodeURIComponent(workerType)}/${encodeURIComponent(sessionId)}/transcript`
      : `${sdkConfig.apiUrl}/api/v1/transcripts/${encodeURIComponent(workerType)}?path=${encodeURIComponent(path!)}`;
    fetch(url, { credentials: 'include' })
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok || json?.ok === false) {
          const code = json?.error_code ?? r.status;
          const msg = json?.error ?? r.statusText;
          throw new Error(`${code}: ${msg}`);
        }
        return parseTranscriptResponse(json);
      })
      .then((parsed) => {
        if (cancelRef.current !== myToken) return;
        setData(parsed);
        setIsLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelRef.current !== myToken) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setData(null);
        setIsLoading(false);
      });
  }, [workerType, path, sessionId, reloadToken]);

  const refetch = useCallback(() => {
    setReloadToken((n) => n + 1);
  }, []);

  return { data, isLoading, error, refetch };
}

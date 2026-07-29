import { ActionInfo, dataManager } from '@sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

type UseActionOptions = {
  enabled?: boolean;
  retry?: boolean | number;
  actionKey?: string[];
};

type UseActionResult<T> = {
  data: T | null;
  error: Error | null;
  loading: boolean;
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  refetch: () => Promise<void>;
};

export function useAction<T>(actionInfo: ActionInfo | null, options: UseActionOptions = {}): UseActionResult<T> {
  const enabled = (options.enabled ?? true) && !!actionInfo;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const actionRef = useRef<ActionInfo | null>(actionInfo);
  actionRef.current = actionInfo;

  const inFlightControllerRef = useRef<AbortController | null>(null);
  const fetchSeqRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(false);
  const lastFetchedUrlRef = useRef<string | null>(null);

  const doFetch = useCallback(async () => {
    if (!actionRef.current) return;

    if (inFlightControllerRef.current) {
      try {
        inFlightControllerRef.current.abort();
      } catch {
        // Ignore abort errors
      }
    }

    const controller = new AbortController();
    inFlightControllerRef.current = controller;
    const currentSeq = ++fetchSeqRef.current;

    setLoading(true);
    setError(null);

    try {
      const current = actionRef.current;
      if (current) {
        current.abortSignal = controller.signal;
        const response = await dataManager.callAction<null, T>(current);
        if (mountedRef.current && currentSeq === fetchSeqRef.current) {
          setData((response as unknown as T) ?? null);
        }
      }
    } catch (e: unknown) {
      if (!controller.signal.aborted && mountedRef.current && currentSeq === fetchSeqRef.current) {
        console.log('use action error', e);
        const err = e instanceof Error ? e : new Error(String(e));
        setError(err);
      }
    } finally {
      if (mountedRef.current && currentSeq === fetchSeqRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const refetch = useCallback(async () => {
    if (!enabled) return;
    lastFetchedUrlRef.current = null; // Allow re-fetch of same URL
    await doFetch();
  }, [doFetch, enabled]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // React Strict Mode intentionally runs effect setup → cleanup → setup on
      // first mount. Cleanup aborts the first request, so its URL must become
      // fetchable again; otherwise the replacement setup mistakes the aborted
      // request for a completed one and leaves the hook permanently empty.
      lastFetchedUrlRef.current = null;
      if (inFlightControllerRef.current) {
        try {
          inFlightControllerRef.current.abort();
        } catch {
          // Ignore abort errors
        }
      }
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const url = actionInfo?.actionUrl ?? null;
    // Skip if we already fetched (or are fetching) this exact URL
    if (url && url === lastFetchedUrlRef.current) return;
    lastFetchedUrlRef.current = url;
    setData(null);
    setError(null);
    setLoading(true);
    void doFetch();
  }, [enabled, doFetch, actionInfo?.actionUrl, actionInfo?.method]);

  return {
    data,
    error,
    loading,
    isLoading: loading,
    isError: !!error,
    isSuccess: !loading && !error && data !== null,
    refetch,
  };
}

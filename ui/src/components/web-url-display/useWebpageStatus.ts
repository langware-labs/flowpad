import apiClient from '@sdk/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WebpageStatus } from './classify';

/**
 * One check per URL for the life of the page. A tab switch remounts the display
 * (the frame itself is parked by `PersistentIframe` and does not reload), and two
 * surfaces can show the same URL; neither should cost another fetch of the
 * external site. Only an explicit recheck replaces an entry. A failed check is
 * not kept, so the next mount tries again.
 */
const checks = new Map<string, Promise<WebpageStatus | null>>();

function check(url: string, fresh: boolean): Promise<WebpageStatus | null> {
  const cached = checks.get(url);
  if (cached && !fresh) return cached;
  const pending: Promise<WebpageStatus | null> = apiClient
    .post<WebpageStatus>('/api/v1/web/status', { url, embedder_origin: window.location.origin })
    .then((data) => data ?? null)
    .catch(() => {
      if (checks.get(url) === pending) checks.delete(url);
      return null;
    });
  checks.set(url, pending);
  return pending;
}

/** Test seam: the cache is module-level, so each test starts from nothing. */
export function clearWebpageStatusCache(): void {
  checks.clear();
}

/**
 * Ask the backend whether `url` can be framed and is reachable.
 *
 * The browser cannot answer this itself -- a refused frame fires `onload` like a
 * working one -- so the backend reads the response headers. `window.location.origin`
 * is sent as the embedder because `SAMEORIGIN` / `frame-ancestors 'self'` are
 * judged against it. A failed check yields null: the check is a diagnostic,
 * never a reason to hide a page that may be fine.
 */
export function useWebpageStatus(url: string): { status: WebpageStatus | null; recheck: () => void } {
  const [result, setResult] = useState<{ url: string; status: WebpageStatus | null } | null>(null);
  const [nonce, setNonce] = useState(0);
  const freshRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const fresh = freshRef.current;
    freshRef.current = false;
    void check(url, fresh).then((status) => {
      if (!cancelled) setResult({ url, status });
    });
    return () => {
      cancelled = true;
    };
  }, [url, nonce]);

  const recheck = useCallback(() => {
    freshRef.current = true;
    setNonce((n) => n + 1);
  }, []);

  // Keyed by URL so a new address never shows the previous one's verdict, while a
  // recheck of the same address keeps the current verdict up until the answer.
  return { status: result?.url === url ? result.status : null, recheck };
}

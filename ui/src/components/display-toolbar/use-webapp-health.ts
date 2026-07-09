import { useEffect, useState } from 'react';

export type WebappHealth = 'checking' | 'up' | 'down';

/**
 * Lightweight reachability check for a shown web app — the artifact-independent
 * equivalent of `ServiceStatusLed` for the `flow show webapp --port` path (no
 * WEBAPP artifact, so the machine-status service list is unavailable). Polls the
 * `get-host` URL every `intervalMs`, pausing while the tab is hidden (mirrors
 * the ServiceStatusLed poll pattern). `up` when the request resolves without a
 * network error — `get-host` 307-redirects to the dev server, so a resolved
 * response means the port is serving; a thrown fetch means nothing is there.
 */
export function useWebappHealth(host: string | null | undefined, intervalMs = 5000): WebappHealth {
  const [health, setHealth] = useState<WebappHealth>('checking');

  useEffect(() => {
    if (!host) {
      setHealth('checking');
      return;
    }
    let cancelled = false;

    const ping = async () => {
      try {
        // credentials for the same-origin get-host action; the redirect target
        // (localhost dev server) is cross-origin + opaque, which is fine — a
        // non-throwing result means the chain reached a live server.
        await fetch(host, { method: 'GET', credentials: 'include', mode: 'no-cors' });
        if (!cancelled) setHealth('up');
      } catch {
        if (!cancelled) setHealth('down');
      }
    };

    void ping();
    let id = window.setInterval(() => void ping(), intervalMs);

    const onVisibility = () => {
      if (document.hidden) {
        window.clearInterval(id);
      } else {
        void ping();
        id = window.setInterval(() => void ping(), intervalMs);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [host, intervalMs]);

  return health;
}

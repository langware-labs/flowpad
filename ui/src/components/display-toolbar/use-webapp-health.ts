import { useEffect, useState } from 'react';

export type WebappHealth = 'checking' | 'up' | 'down';

/**
 * Lightweight reachability check for a shown web app. Polls the URL the frame
 * loads — a dev server's direct address or an endpoint's `service` path — every
 * `intervalMs`, pausing while the tab is hidden. `up` when the request resolves
 * without a network error, so a resolved response means something is serving;
 * a thrown fetch means nothing is there.
 *
 * NOTE the asymmetry this creates, because callers depend on it: `mode:
 * 'no-cors'` resolves opaquely for ANY HTTP answer, so a server returning 500
 * reads as `up`. This signal answers "is something listening", not "is the app
 * working" — the backend probe covers the difference.
 *
 * Polling is shared per host rather than per hook. The same app is watched by
 * both the display and its toolbar LED, and one interval each would double the
 * request rate and let the two surfaces disagree about the same URL.
 */

interface HostWatch {
  health: WebappHealth;
  subscribers: Set<(health: WebappHealth) => void>;
  intervalId: number;
  intervalMs: number;
  onVisibility: () => void;
}

const watches = new Map<string, HostWatch>();

function publish(watch: HostWatch, health: WebappHealth) {
  if (watch.health === health) return;
  watch.health = health;
  watch.subscribers.forEach((notify) => notify(health));
}

async function ping(host: string, watch: HostWatch) {
  try {
    // credentials for a same-origin `service` path; a dev server's own origin is
    // cross-origin + opaque, which is fine — a non-throwing result means the
    // request reached a live server.
    await fetch(host, { method: 'GET', credentials: 'include', mode: 'no-cors' });
    publish(watch, 'up');
  } catch {
    publish(watch, 'down');
  }
}

function subscribe(host: string, intervalMs: number, notify: (health: WebappHealth) => void): () => void {
  let watch = watches.get(host);
  if (!watch) {
    const created: HostWatch = {
      health: 'checking',
      subscribers: new Set(),
      intervalId: 0,
      intervalMs,
      onVisibility: () => {},
    };
    created.onVisibility = () => {
      window.clearInterval(created.intervalId);
      if (!document.hidden) {
        void ping(host, created);
        created.intervalId = window.setInterval(() => void ping(host, created), created.intervalMs);
      }
    };
    document.addEventListener('visibilitychange', created.onVisibility);
    created.intervalId = window.setInterval(() => void ping(host, created), intervalMs);
    watches.set(host, created);
    watch = created;
    void ping(host, created);
  }

  const active = watch;
  active.subscribers.add(notify);
  notify(active.health);

  return () => {
    active.subscribers.delete(notify);
    if (active.subscribers.size > 0) return;
    window.clearInterval(active.intervalId);
    document.removeEventListener('visibilitychange', active.onVisibility);
    watches.delete(host);
  };
}

export function useWebappHealth(host: string | null | undefined, intervalMs = 5000): WebappHealth {
  const [health, setHealth] = useState<WebappHealth>('checking');

  useEffect(() => {
    if (!host) {
      setHealth('checking');
      return;
    }
    return subscribe(host, intervalMs, setHealth);
  }, [host, intervalMs]);

  return health;
}

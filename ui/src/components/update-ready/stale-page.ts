import { useEffect, useState } from 'react';
import { connectionManager } from '@sdk';

/**
 * A page that outlived its server: Flowpad was updated and restarted while this tab stayed open, so the tab
 * runs the previous UI against the new server. Answers that were reshaped in between then break it (a footer
 * chip reading a field the new server no longer sends blanked the whole app, 2026-11-21).
 *
 * Told apart by the entry script: the one this page loaded against the one the server's page shell names now.
 * That differs on every rebuild, also between two builds of one version. Asked once per reconnect — a server
 * restart is the only way the shell changes under an open page.
 */
const ENTRY_SCRIPT = /<script[^>]+src="([^"]*\/assets\/index-[^"]+\.js)"/;

/** The entry script a built page shell names; null for a shell that has none (a dev server's). */
export function entryScriptOf(html: string): string | null {
  return ENTRY_SCRIPT.exec(html)?.[1] ?? null;
}

/** This page's own shell is asked for, relative to the page — not a backend route. */
async function servedEntryScript(): Promise<string | null> {
  const response = await fetch('/', { cache: 'no-store', headers: { Accept: 'text/html' } });
  return response.ok ? entryScriptOf(await response.text()) : null;
}

/** True once the server serves a newer UI than the one this page runs. */
export function useStalePage(): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const mine = document.querySelector('script[src*="/assets/index-"]')?.getAttribute('src');
    if (!mine) return undefined;
    const stop = () => void connectionManager.off('on_reconnected', check);
    function check() {
      void servedEntryScript()
        .then((served) => {
          if (!served || served === mine) return;
          setStale(true);
          stop();
        })
        .catch(() => {
          /* not reachable yet: the next reconnect asks again */
        });
    }
    connectionManager.on('on_reconnected', check);
    return stop;
  }, []);
  return stale;
}

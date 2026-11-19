/**
 * The apps this machine serves now and who has them open — the activity panel's Hosted apps tab.
 *
 * A MIRROR of the backend's answer (`WebApp.hosted()`), never a second source of truth: it reads on first
 * use, on every socket (re)connect, and whenever the backend says the list changed (`hosted_apps`). It never
 * polls and nothing here writes a row.
 */
import { dataContext, HOSTED_APPS_ELEMENT, WebApp, type HostedApp } from '@sdk';
import { connectionManager } from '@sdk/websocket';
import { useSyncExternalStore } from 'react';

const EMPTY: ReadonlyArray<HostedApp> = [];
let snapshot: ReadonlyArray<HostedApp> = EMPTY;
const listeners = new Set<() => void>();
let attached = false;
/** Only the newest read lands: an older answer arriving late must not overwrite a newer one. */
let reads = 0;

/** Read the list from the backend. The hub serves no local apps, so it stays empty there. */
export async function refreshHostedApps(): Promise<void> {
  if (!dataContext.caps.localFiles) return;
  const mine = ++reads;
  const rows = await WebApp.hosted();
  if (mine !== reads) return;
  snapshot = rows;
  for (const l of listeners) l();
}

function attachOnce(): void {
  if (attached) return;
  attached = true;
  const read = () => void refreshHostedApps().catch(() => {});
  connectionManager.on('on_flow_data', (_typeId: unknown, flowData: Record<string, unknown>) => {
    if (flowData?.element_type === HOSTED_APPS_ELEMENT) read();
  });
  connectionManager.on('on_open', read);
  read();
}

function subscribe(listener: () => void): () => void {
  attachOnce();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;

export function useHostedApps(): ReadonlyArray<HostedApp> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function __resetHostedAppsStoreForTest(): void {
  snapshot = EMPTY;
  listeners.clear();
  attached = false;
  reads = 0;
}

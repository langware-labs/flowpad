import { useSyncExternalStore } from 'react';

export const TAB_HIGHLIGHT_MS = 2000;
let sequence = 0;
let requests: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();
const snapshot = () => requests;
const notify = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A brief, local presentation cue. Retain it across the newly created tab's first render. */
export function highlightTab(key: string): void {
  const token = ++sequence;
  requests = new Map(requests).set(key, token);
  notify();
  // Expire unseen requests too, so switching projects later cannot replay an old show.
  window.setTimeout(() => {
    if (requests.get(key) !== token) return;
    const next = new Map(requests);
    next.delete(key);
    requests = next;
    notify();
  }, TAB_HIGHLIGHT_MS);
}

/** Remove a request once its tab has rendered and started the cue. */
export function consumeTabHighlight(key: string, token: number): void {
  if (requests.get(key) !== token) return;
  const next = new Map(requests);
  next.delete(key);
  requests = next;
  notify();
}

export function useTabHighlights(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

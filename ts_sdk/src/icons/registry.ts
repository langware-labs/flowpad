import apiClient, { GRAPH_API_PREFIX } from '../client';
import { resolveIcon } from './resolve';
import type { IconPackSpec, IconResolution } from './types';

/**
 * The loaded icon vocabulary, held once per app.
 *
 * Packs are static and definitional, so they arrive with the bootstrap payload
 * (`icon_packs`) exactly like `types` does — one fetch at startup, no
 * per-component round-trips. `fetchIconPacks` exists for everything that is not
 * a booting app: a standalone page, a script, a plugin.
 *
 * Subscription is deliberately minimal. This is load-once data; the listener
 * list exists so a component mounted before the bootstrap resolves re-renders
 * when it lands, not because packs churn.
 */

let packs: IconPackSpec[] = [];
const listeners = new Set<() => void>();

/** Seed the registry from a bootstrap payload. */
export function loadIconPacks(next: IconPackSpec[] | undefined | null): void {
  packs = Array.isArray(next) ? next : [];
  listeners.forEach((fn) => fn());
}

/** The packs, in resolution order. */
export function getIconPacks(): IconPackSpec[] {
  return packs;
}

/** Notify on load. Returns an unsubscribe. */
export function onIconPacksChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Fetch the packs from the backend's `icons` action and seed the registry.
 *
 * A page that is not a booting Flowpad app calls this instead. It goes through
 * `apiClient`, which carries the base URL, auth and the `{status,data}`
 * envelope — an app must never build a backend URL itself.
 */
export async function fetchIconPacks(): Promise<IconPackSpec[]> {
  // The client's interceptor already unwrapped the `{status,data}` envelope,
  // so this IS the action's `data`.
  const res: unknown = await apiClient.get(`${GRAPH_API_PREFIX}/icons`);
  const body = (res || {}) as { icon_packs?: IconPackSpec[] };
  loadIconPacks(body.icon_packs || []);
  return packs;
}

/** Resolve against the loaded packs — the non-React entry point. */
export function resolve(ref: string | null | undefined): IconResolution {
  return resolveIcon(ref, packs);
}

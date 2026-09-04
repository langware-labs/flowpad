import apiClient, { GRAPH_API_PREFIX } from '../client';
import type { IconPackSpec } from './types';

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

/**
 * What renders when nothing claims a tag.
 *
 * `lucideByName` never returns nothing — a null name, a typo and a missing file
 * all land on `FileText`, deliberately, so "unknown icon" and "no icon" look the
 * same rather than one of them vanishing. A drop-in has to keep that: an icon
 * that silently disappears reads as a layout bug, and a row loses the column
 * that told you what it was.
 *
 * A tag rather than a component, so it resolves through the same registry and
 * works on the no-React path too. Set to `null` to render nothing instead.
 */
let fallbackTag: string | null = 'lucide.file-text';

export function setIconFallback(tag: string | null): void {
  fallbackTag = tag;
}

export function getIconFallback(): string | null {
  return fallbackTag;
}

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


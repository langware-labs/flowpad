/**
 * The live half of a `breadcrumb` block: what the tag index currently says.
 *
 * A fence renderer is called again on every theme change, every editable flip
 * and every debounce tick while the author types in the Code pane, and it is
 * handed a fresh host element each time. Nothing can live in a renderer
 * closure. So the join lives here, at module scope, keyed by the data that
 * produced it — which also means N fences sharing a tag cost one walk, and a
 * theme toggle costs none.
 *
 * Two rules this module exists to enforce:
 *
 * * **It never throws.** A rejected fetch propagating into `render()` would
 *   trip the NodeView's error path and blank the authored fallback — punishing
 *   the author for a backend that happens to be down.
 * * **Failures are cached too.** `POST /api/v1/tags/context` answers the `code`
 *   half with a live, gitignore-respecting filesystem walk. Without negative
 *   caching, an unreachable backend turns the typing debounce into a request
 *   storm against the most expensive endpoint in the join.
 */

import apiClient from '@sdk/client';

import type { BreadcrumbSite } from './breadcrumb-schema';

/** How long a join — success or failure — is trusted before a refetch. */
const CONTEXT_TTL_MS = 30_000;

/**
 * Cap on remembered joins. A module-scope Map in a long-lived SPA otherwise
 * grows for every breadcrumb doc the user browses past.
 */
const MAX_CACHE_ENTRIES = 50;

/** The `code` half of the tag-context response — the only half this reads. */
interface TagContextCodeSite {
  path: string;
  line: number;
  tags: Record<string, string>;
}

interface TagContextResponse {
  code?: TagContextCodeSite[];
}

export interface BreadcrumbContextEntry {
  /** Epoch ms of the last settled attempt; 0 while the first is in flight. */
  fetchedAt: number;
  /** Last GOOD join. Survives a later failure on purpose. */
  sites: BreadcrumbSite[] | null;
  /** Why the last attempt failed, or null. */
  error: string | null;
  /** Non-null while a request is outstanding — the "pending" signal too. */
  inFlight: Promise<void> | null;
}

const CACHE = new Map<string, BreadcrumbContextEntry>();

/** `\0` because a tag can't contain one and a path shouldn't. */
function cacheKey(tag: string, root: string): string {
  return `${tag}\u0000${root}`;
}

/**
 * The note to show for a code site.
 *
 * `scan_code_capsules` matches by hierarchy (`tag_is_within`), so a site
 * returned for `breadcrumb.test.x.rules` may actually carry a descendant of it.
 * Take the exact match when there is one, accept a lone entry as unambiguous,
 * and otherwise show nothing rather than guessing between several notes.
 */
function noteFor(tags: Record<string, string> | undefined, tag: string): string | undefined {
  if (!tags) return undefined;
  const exact = tags[tag];
  if (typeof exact === 'string' && exact) return exact;
  const values = Object.values(tags).filter((value) => typeof value === 'string' && value);
  return values.length === 1 ? values[0] : undefined;
}

/**
 * Make room for one more entry.
 *
 * Called BEFORE the new entry is inserted, not after: a fresh entry has
 * `fetchedAt: 0` and would otherwise always be the oldest thing in the map —
 * evicting itself the moment it was added, and orphaning its own request.
 */
function evictIfFull(): void {
  if (CACHE.size < MAX_CACHE_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldestAt = Infinity;
  for (const [key, entry] of CACHE) {
    // Never evict a request that is still outstanding — its `onSettled` would
    // write into an entry nobody can read back.
    if (entry.inFlight) continue;
    if (entry.fetchedAt < oldestAt) {
      oldestAt = entry.fetchedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) CACHE.delete(oldestKey);
}

/** A blank entry, in the map, with room made for it. */
function insertEntry(key: string): BreadcrumbContextEntry {
  evictIfFull();
  const entry: BreadcrumbContextEntry = { fetchedAt: 0, sites: null, error: null, inFlight: null };
  CACHE.set(key, entry);
  return entry;
}

/** What the cache knows right now. A plain read — never starts a request. */
export function peekBreadcrumbContext(tag: string, root: string): BreadcrumbContextEntry | undefined {
  return CACHE.get(cacheKey(tag, root));
}

/**
 * Ensure a fresh-enough join exists, calling `onSettled` if one was fetched.
 *
 * `onSettled` is a one-shot callback, not a subscription: `FenceRenderer` has
 * no teardown hook, so a lasting registration would leak on every NodeView
 * destroy. Callers guard it with `host.isConnected`.
 */
export function ensureBreadcrumbContext(tag: string, root: string, onSettled: () => void): void {
  const key = cacheKey(tag, root);
  const cached = CACHE.get(key);

  if (cached?.inFlight) return; // joined, not duplicated
  if (cached && Date.now() - cached.fetchedAt < CONTEXT_TTL_MS) return;

  const entry = cached ?? insertEntry(key);

  entry.inFlight = (async () => {
    try {
      // Path only — the SDK client owns the base URL, and its response
      // interceptor has already unwrapped the {status,data} envelope.
      // `parts: ['code']` — the card reads nothing else, and the halves it
      // would otherwise buy are not cheap: the docs half reads and summarises
      // every bound doc, which for a breadcrumb tag is the page being rendered.
      const data = (await apiClient.post('/api/v1/tags/context', {
        name: tag,
        mode: 'line',
        root,
        parts: ['code'],
      })) as unknown as TagContextResponse | null;

      const code = data?.code ?? [];
      // An empty result does NOT clear a good previous answer, and the caller
      // keeps its authored rows: `root` is the document's project, which may
      // simply not be the repo holding the test. Replacing a useful list with
      // an empty one would be a regression, not an update.
      if (code.length > 0) {
        entry.sites = code.map((site) => ({
          relPath: site.path,
          line: site.line,
          note: noteFor(site.tags, tag),
        }));
      }
      entry.error = null;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    } finally {
      entry.fetchedAt = Date.now();
      entry.inFlight = null;
    }
  })();

  void entry.inFlight.then(onSettled);
}

/** Drop a cached join so the next `ensure` refetches. Used by the refresh control. */
export function invalidateBreadcrumbContext(tag: string, root: string): void {
  CACHE.delete(cacheKey(tag, root));
}

/** @internal — test seam, mirroring `clearFenceRenderers`. */
export function __resetBreadcrumbContextCache(): void {
  CACHE.clear();
}

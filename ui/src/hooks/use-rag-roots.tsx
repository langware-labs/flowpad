/**
 * Which folders are a RAG index ROOT, as canonical machine paths.
 *
 * A context, not a prop threaded through the tree adapters, and the difference is not
 * cosmetic. Tree rows are BUILT once and cached by node id, so a `Set` captured at build time
 * is frozen at whatever the answer was when that row was first listed — and the roots arrive
 * from a query a beat after the tree has already expanded. The badge would then be right only
 * for rows listed after the query landed. Reading the context inside the glyph moves the
 * lookup to render time, where the answer can still change.
 *
 * One subscription for the whole tree: the provider queries, and every row reads a plain
 * context value. A `useEntitiesQuery` per row would open a subscription per row.
 *
 * Global by construction (`scope: []`), like the source and credential definitions: an index
 * belongs to the instance, and switching project must not change which folders are covered.
 *
 * Roots only, never their descendants — the marker says "coverage was chosen here", and
 * branding a whole subtree would make it say something vaguer.
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { t } from '@lingui/core/macro';
import { isHubOnly, QueryRequest, RagIndex } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { notify } from '@src/notifications';

/** Stable empty value — a fresh `Set` per render would churn every consumer's memo. */
const NO_ROOTS: Set<string> = new Set();

const RagRootsContext = createContext<Set<string>>(NO_ROOTS);
/** The roots of every index whose pass is running right now — the same shape, a second answer. */
const RagIndexingContext = createContext<Set<string>>(NO_ROOTS);

/**
 * The roots of the indexes *which* accepts, as a `Set` that keeps its identity while its contents
 * do. Every pass broadcasts its row twice; a fresh `Set` each time would re-render every tree row.
 */
function useStableRoots(indexes: RagIndex[] | undefined, which: (index: RagIndex) => boolean): Set<string> {
  const key = (indexes ?? [])
    .filter(which)
    .flatMap((index) => index.roots ?? [])
    .sort()
    .join('\n');
  return useMemo(() => (key ? new Set(key.split('\n')) : NO_ROOTS), [key]);
}

/**
 * Say so when a pass lands: the toast for "it's done", raised on the row's `indexing` going
 * true → false. Here and only here, because this provider is mounted once for the whole app —
 * a watcher per tree row or per card would toast once per copy on screen.
 */
function useAnnounceFinishedPasses(indexes: RagIndex[] | undefined) {
  const wasIndexing = useRef(new Map<string, boolean>());
  useEffect(() => {
    for (const index of indexes ?? []) {
      const before = wasIndexing.current.get(index.id);
      wasIndexing.current.set(index.id, !!index.indexing);
      if (!before || index.indexing) continue;
      const name = index.name || t`Search index`;
      if (index.last_error) {
        notify.error({ title: t`${name}: indexing stopped`, message: index.last_error });
      } else {
        notify.success({
          title: t`${name} is ready to search`,
          message: t`${index.document_count} documents, ${index.chunk_count} chunks`,
        });
      }
    }
  }, [indexes]);
}

export function RagRootsProvider({ children }: { children: ReactNode }) {
  // Built inside the component, not at module scope: `RagIndex` comes through the `@sdk`
  // barrel, and reading its static `type` during this module's own initialisation depends on
  // import order — losing that race mints a query with no type that quietly never fires.
  const request = useMemo(() => new QueryRequest({ type: RagIndex.type, scope: [], name: 'rag:indexes' }), []);
  // `isHubOnly()`, not a page check: `rag_index` is a DESK type, absent from the hub's
  // type registry, so the query is a 422 there and can never return roots. The provider
  // still wraps the tree on the hub — it just has nothing to ask.
  const { data: indexes } = useEntitiesQuery<RagIndex>(request, { enabled: !isHubOnly() });
  const roots = useStableRoots(indexes, () => true);
  const indexing = useStableRoots(indexes, (index) => index.indexing);
  useAnnounceFinishedPasses(indexes);
  return (
    <RagRootsContext.Provider value={roots}>
      <RagIndexingContext.Provider value={indexing}>{children}</RagIndexingContext.Provider>
    </RagRootsContext.Provider>
  );
}

/** Roots whose index is embedding right now, or an empty set outside the provider. */
export function useRagIndexingRoots(): Set<string> {
  return useContext(RagIndexingContext);
}

/** The roots, or an empty set outside the provider — never a crash and never a wrong badge. */
export function useRagRoots(): Set<string> {
  return useContext(RagRootsContext);
}

/** Whether *path* is a root. Empty and missing paths match nothing. */
export function isRagRoot(roots: Set<string>, path: string | null | undefined): boolean {
  return !!path && roots.has(path);
}

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
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { isHubOnly, QueryRequest, RagIndex } from '@sdk';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';

/** Stable empty value — a fresh `Set` per render would churn every consumer's memo. */
const NO_ROOTS: Set<string> = new Set();

const RagRootsContext = createContext<Set<string>>(NO_ROOTS);

export function RagRootsProvider({ children }: { children: ReactNode }) {
  // Built inside the component, not at module scope: `RagIndex` comes through the `@sdk`
  // barrel, and reading its static `type` during this module's own initialisation depends on
  // import order — losing that race mints a query with no type that quietly never fires.
  const request = useMemo(() => new QueryRequest({ type: RagIndex.type, scope: [], name: 'rag:indexes' }), []);
  // `isHubOnly()`, not a page check: `rag_index` is a DESK type, absent from the hub's
  // type registry, so the query is a 422 there and can never return roots. The provider
  // still wraps the tree on the hub — it just has nothing to ask.
  const { data: indexes } = useEntitiesQuery<RagIndex>(request, { enabled: !isHubOnly() });
  const roots = useMemo(() => {
    if (!indexes?.length) return NO_ROOTS;
    return new Set(indexes.flatMap((index) => index.roots ?? []));
  }, [indexes]);
  return <RagRootsContext.Provider value={roots}>{children}</RagRootsContext.Provider>;
}

/** The roots, or an empty set outside the provider — never a crash and never a wrong badge. */
export function useRagRoots(): Set<string> {
  return useContext(RagRootsContext);
}

/** Whether *path* is a root. Empty and missing paths match nothing. */
export function isRagRoot(roots: Set<string>, path: string | null | undefined): boolean {
  return !!path && roots.has(path);
}

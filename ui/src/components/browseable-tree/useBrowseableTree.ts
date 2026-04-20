import { useCallback, useRef, useState } from 'react';
import type { DockPointer } from '@src/navigation/DockPointer';
import type { Browseable, BrowseableRoot } from './types';

export type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; children: Browseable[] }
  | { status: 'error'; message: string };

export interface BrowseableTreeState {
  /** Set of expanded node ids. */
  expandedIds: Set<string>;
  /** Per-node load state (keyed by Browseable.id). */
  loadStates: Map<string, LoadState>;
}

const EMPTY_STATE: BrowseableTreeState = {
  expandedIds: new Set(),
  loadStates: new Map(),
};

/**
 * State + logic for <BrowseableTree>.
 *
 * Mirrors the shape of `useDirectoryTree`:
 *  - `expandedIds` holds the currently expanded node ids (local, ephemeral).
 *  - `loadStates` tracks per-node children fetches (idle / loading / ready / error).
 *  - `expandParentsForPointer(p)` walks the owning root's pathFor() and
 *    expands every ancestor, priming the cache for each along the way.
 */
export function useBrowseableTree(roots: BrowseableRoot[]) {
  const [state, setState] = useState<BrowseableTreeState>(EMPTY_STATE);

  // Track in-flight fetches to prevent duplicate work on quick toggles.
  const inflight = useRef(new Map<string, Promise<Browseable[]>>());

  const getLoadState = useCallback(
    (id: string): LoadState => state.loadStates.get(id) ?? { status: 'idle' },
    [state.loadStates],
  );

  const getChildren = useCallback(
    (id: string): Browseable[] => {
      const ls = state.loadStates.get(id);
      return ls && ls.status === 'ready' ? ls.children : [];
    },
    [state.loadStates],
  );

  const isExpanded = useCallback(
    (id: string): boolean => state.expandedIds.has(id),
    [state.expandedIds],
  );

  const setLoadState = useCallback((id: string, next: LoadState) => {
    setState((prev) => {
      const loadStates = new Map(prev.loadStates);
      loadStates.set(id, next);
      return { ...prev, loadStates };
    });
  }, []);

  /**
   * Kick off a children fetch for a node. Dedupes concurrent calls.
   * Returns the children on success, or `[]` on failure (error state
   * is stored separately).
   */
  const loadChildren = useCallback(
    async (node: Browseable): Promise<Browseable[]> => {
      if (!node.listChildren) return [];

      const pending = inflight.current.get(node.id);
      if (pending) return pending;

      const current = state.loadStates.get(node.id);
      if (current?.status === 'ready') return current.children;

      setLoadState(node.id, { status: 'loading' });
      const p = (async () => {
        try {
          const children = await node.listChildren!();
          setLoadState(node.id, { status: 'ready', children });
          return children;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setLoadState(node.id, { status: 'error', message });
          return [] as Browseable[];
        } finally {
          inflight.current.delete(node.id);
        }
      })();

      inflight.current.set(node.id, p);
      return p;
    },
    [state.loadStates, setLoadState],
  );

  const expand = useCallback(
    async (node: Browseable) => {
      setState((prev) => {
        if (prev.expandedIds.has(node.id)) return prev;
        const expandedIds = new Set(prev.expandedIds);
        expandedIds.add(node.id);
        return { ...prev, expandedIds };
      });
      // Fire-and-forget load (state updates arrive via setLoadState)
      await loadChildren(node);
    },
    [loadChildren],
  );

  const collapse = useCallback((id: string) => {
    setState((prev) => {
      if (!prev.expandedIds.has(id)) return prev;
      const expandedIds = new Set(prev.expandedIds);
      expandedIds.delete(id);
      return { ...prev, expandedIds };
    });
  }, []);

  const toggleExpand = useCallback(
    async (node: Browseable) => {
      if (state.expandedIds.has(node.id)) {
        collapse(node.id);
      } else {
        await expand(node);
      }
    },
    [state.expandedIds, collapse, expand],
  );

  /**
   * Expand every ancestor of the node addressed by `pointer`. The first
   * root whose `ownsPointer` returns true is used; its `pathFor` is walked
   * and each non-leaf ancestor is added to `expandedIds`. Cached results
   * are primed from the returned chain so the rendered tree doesn't need
   * to refetch.
   */
  const expandParentsForPointer = useCallback(
    async (pointer: DockPointer | null): Promise<Browseable | null> => {
      if (!pointer) return null;
      const owner = roots.find((r) => r.ownsPointer(pointer));
      if (!owner) return null;

      let chain: Browseable[];
      try {
        chain = await owner.pathFor(pointer);
      } catch {
        return null;
      }
      if (chain.length === 0) return null;

      const idsToExpand = chain.slice(0, -1).map((n) => n.id);
      // Also ensure the chain is visible by priming caches when we can
      // infer a parent→children relationship from two adjacent nodes.
      setState((prev) => {
        const expandedIds = new Set(prev.expandedIds);
        for (const id of idsToExpand) expandedIds.add(id);
        return { ...prev, expandedIds };
      });

      // For each ancestor that doesn't yet have cached children, trigger a
      // fresh load. We don't try to stitch a partial chain into the cache;
      // the adapter's listChildren is the source of truth.
      for (const node of chain.slice(0, -1)) {
        if (!node.listChildren) continue;
        const existing = state.loadStates.get(node.id);
        if (existing?.status !== 'ready') {
          await loadChildren(node);
        }
      }

      return chain[chain.length - 1];
    },
    [roots, state.loadStates, loadChildren],
  );

  return {
    state,
    isExpanded,
    getLoadState,
    getChildren,
    loadChildren,
    expand,
    collapse,
    toggleExpand,
    expandParentsForPointer,
  };
}

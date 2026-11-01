import { useCallback, useEffect, useRef, useState } from 'react';
import type { DockPointer } from '@src/navigation/DockPointer';
import type { Browseable, BrowseableRoot } from './types';

export type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  /**
   * `refreshing` = an `invalidate` re-fetch is in flight over children we
   * already have. The previous children stay rendered until the fresh list
   * lands, so a burst of entity ops (e.g. create-group-task writing one member
   * task per member) repaints the rows once instead of flashing "Loading…"
   * between every op. `loading` is reserved for a genuine first load.
   */
  | { status: 'ready'; children: Browseable[]; refreshing?: boolean }
  | { status: 'error'; message: string };

export interface BrowseableTreeState {
  /** Set of expanded node ids. */
  expandedIds: Set<string>;
  /** Per-node load state (keyed by Browseable.id). */
  loadStates: Map<string, LoadState>;
}

export interface BrowseableTreeOptions {
  /**
   * localStorage key for the expanded-ids set. When given, the initial state
   * is read from localStorage and every expansion change is written back.
   */
  persistKey?: string;
  /**
   * Node ids expanded when there is no persisted state yet (e.g. the root id
   * so the first layer opens by default).
   */
  defaultExpandedIds?: string[];
}

/** Read the persisted expanded-ids set; null when absent/unreadable. */
function readPersistedExpandedIds(persistKey: string): Set<string> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(persistKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return null;
  }
}

/**
 * State + logic for <BrowseableTree>.
 *
 * Mirrors the shape of `useDirectoryTree`:
 *  - `expandedIds` holds the currently expanded node ids (local by default;
 *    pass `persistKey` to restore/persist via localStorage, and
 *    `defaultExpandedIds` to seed first-open expansion).
 *  - `loadStates` tracks per-node children fetches (idle / loading / ready / error).
 *  - `expandParentsForPointer(p, rootId?)` expands the ancestors of `p` in
 *    the first root that holds it (or in `rootId`), priming the cache.
 */
export function useBrowseableTree(roots: BrowseableRoot[], options: BrowseableTreeOptions = {}) {
  const { persistKey, defaultExpandedIds } = options;
  const [state, setState] = useState<BrowseableTreeState>(() => ({
    expandedIds: (persistKey ? readPersistedExpandedIds(persistKey) : null) ?? new Set(defaultExpandedIds ?? []),
    loadStates: new Map(),
  }));

  // Persist expansion changes (mirror of PromptIndexPanel's sort-dir pattern).
  useEffect(() => {
    if (!persistKey) return;
    try {
      window.localStorage.setItem(persistKey, JSON.stringify([...state.expandedIds]));
    } catch {
      // localStorage may be unavailable (private mode, quota) — expansion simply doesn't persist.
    }
  }, [persistKey, state.expandedIds]);

  // Ref mirror of `loadStates` for the async workers (`loadChildren`,
  // `expandParentsForPointer`) to read WITHOUT listing `state.loadStates` in
  // their dep arrays. Each `setLoadState` mutates `loadStates`; if the workers
  // depended on it they'd be recreated on every fetch, and the consumer effect
  // in <BrowseableTree> (keyed on `expandParentsForPointer`'s identity) would
  // re-run — re-entering the walk before its async guard latches and firing a
  // burst of redundant child fetches. Render-phase assignment keeps the ref at
  // the latest committed value.
  const loadStatesRef = useRef(state.loadStates);
  loadStatesRef.current = state.loadStates;

  // Track in-flight fetches to prevent duplicate work on quick toggles.
  const inflight = useRef(new Map<string, Promise<Browseable[]>>());

  // Per-node invalidate generation. A burst of entity ops fires overlapping
  // `invalidate`s, and their fetches can resolve out of order — an older
  // response must never overwrite a newer one's children.
  const refreshSeq = useRef(new Map<string, number>());
  // Nodes invalidated while collapsed: their next load passes `{ refresh: true }`.
  const stale = useRef(new Set<string>());

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

  const isExpanded = useCallback((id: string): boolean => state.expandedIds.has(id), [state.expandedIds]);

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

      const current = loadStatesRef.current.get(node.id);
      if (current?.status === 'ready') return current.children;

      setLoadState(node.id, { status: 'loading' });
      // Invalidated while collapsed: this expand must read past adapter caches too.
      const refresh = stale.current.delete(node.id);
      const p = (async () => {
        try {
          const children = await node.listChildren!(refresh ? { refresh: true } : undefined);
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
    [setLoadState],
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
   * Invalidate a node's cached children. If the node is currently expanded,
   * its children are re-fetched immediately; expansion state is preserved.
   * If the node isn't expanded, the next expansion will fetch fresh data.
   *
   * Walks every root looking for the node so callers (e.g. refresh-store
   * listeners) can pass an arbitrary id — they don't need to hold a node ref.
   *
   * Bypasses `loadChildren`'s cache-hit shortcut (which would return the
   * stale "ready" entry from the captured state snapshot) by calling
   * `node.listChildren` directly.
   */
  const invalidate = useCallback(
    async (nodeId: string): Promise<void> => {
      const findNode = (n: Browseable): Browseable | null => {
        if (n.id === nodeId) return n;
        const cached = state.loadStates.get(n.id);
        if (cached?.status === 'ready') {
          for (const c of cached.children) {
            const hit = findNode(c);
            if (hit) return hit;
          }
        }
        return null;
      };
      let node: Browseable | null = null;
      for (const root of roots) {
        node = findNode(root);
        if (node) break;
      }
      const refresh = async (target: Browseable): Promise<void> => {
        const id = target.id;
        inflight.current.delete(id);
        if (!target.listChildren || !state.expandedIds.has(id)) {
          // Not expanded — drop it and every cached row under it, so the next
          // expand fetches fresh (past adapter caches) instead of showing old rows.
          const drop = (n: Browseable) => {
            const cached = loadStatesRef.current.get(n.id);
            if (cached?.status === 'ready') cached.children.forEach(drop);
            stale.current.add(n.id);
            setLoadState(n.id, { status: 'idle' });
          };
          drop(target);
          return;
        }
        const seq = (refreshSeq.current.get(id) ?? 0) + 1;
        refreshSeq.current.set(id, seq);
        // Keep the rows we already have on screen while the re-fetch runs;
        // only a node with nothing cached shows the "Loading…" placeholder.
        const cached = loadStatesRef.current.get(id);
        setLoadState(
          id,
          cached?.status === 'ready'
            ? { status: 'ready', children: cached.children, refreshing: true }
            : { status: 'loading' },
        );
        let children: Browseable[];
        try {
          // `{ refresh: true }` so adapters that own a cache (e.g. the skill /
          // markdown folder adapters' fsStore browseCache) bypass it — an
          // invalidate's whole purpose is to reflect fresh on-disk state (e.g.
          // after a delete). Adapters that always fetch (asset /search) ignore it.
          children = await target.listChildren({ refresh: true });
          // A newer invalidate started while this fetch was in flight — its
          // result is the fresh one; drop ours rather than clobber it.
          if (refreshSeq.current.get(id) !== seq) return;
          setLoadState(id, { status: 'ready', children });
        } catch (err) {
          if (refreshSeq.current.get(id) !== seq) return;
          const message = err instanceof Error ? err.message : String(err);
          setLoadState(id, { status: 'error', message });
          return;
        }
        // An open child still lists what it listed before: re-list it from the
        // FRESH child (a markdown folder derives its rows from its parent's walk),
        // or a deleted file stays on screen under an expanded folder.
        await Promise.all(children.filter((c) => state.expandedIds.has(c.id)).map(refresh));
      };
      if (node) await refresh(node);
      else setLoadState(nodeId, { status: 'idle' });
    },
    [roots, state.expandedIds, state.loadStates, setLoadState],
  );

  /**
   * Expand every ancestor of every node addressed by `pointer`. All roots
   * whose `ownsPointer` returns true participate; this lets one canonical VFS
   * resource expand in multiple presentations (for example Markdown + Files).
   * Leaves are returned in root order so the renderer can scroll the first
   * visible match deterministically.
   */
  const expandParentsForPointer = useCallback(
    async (pointer: DockPointer | null, rootId?: string): Promise<Browseable[]> => {
      if (!pointer) return [];
      const owners = roots.filter((r) => (!rootId || r.id === rootId) && r.ownsPointer(pointer));
      if (owners.length === 0) return [];

      const leaves: Browseable[] = [];
      for (const owner of owners) {
        let chain: Browseable[];
        try {
          chain = await owner.pathFor(pointer);
        } catch {
          continue;
        }
        if (chain.length === 0) continue;

        // Expand every node in the chain whose `hasChildren !== false`.
        // This keeps editor-file leaves (hasChildren: false) untouched while
        // ensuring folder leaves auto-expand themselves on deep-link.
        const nodesToExpand = chain.filter((n) => n.hasChildren !== false);
        setState((prev) => {
          const expandedIds = new Set(prev.expandedIds);
          for (const n of nodesToExpand) expandedIds.add(n.id);
          return { ...prev, expandedIds };
        });

        // Load each expandable node; capture the parent-of-leaf's children so
        // the freshness check below sees them without a stale closure read.
        const leaf = chain[chain.length - 1];
        leaves.push(leaf);
        const parent = chain.length >= 2 ? chain[chain.length - 2] : null;
        let parentChildren: Browseable[] | null = null;
        for (const node of nodesToExpand) {
          if (!node.listChildren) continue;
          const existing = loadStatesRef.current.get(node.id);
          const children = existing?.status === 'ready' ? existing.children : await loadChildren(node);
          if (parent && node.id === parent.id) parentChildren = children;
        }

        // Deep-link freshness: leaf missing from parent's listing → just-created
        // file the cached listing pre-dates. Force-refresh past both caches,
        // keeping the rows already on screen (as `invalidate` does): this walk
        // re-runs on every roots change, so a reset to "Loading…" here blinks
        // the folder each time.
        if (parent && parent.listChildren && parentChildren) {
          const leafPresent = parentChildren.some((c) => c.id === leaf.id);
          if (!leafPresent) {
            inflight.current.delete(parent.id);
            setLoadState(parent.id, { status: 'ready', children: parentChildren, refreshing: true });
            try {
              const refreshed = await parent.listChildren({ refresh: true });
              setLoadState(parent.id, { status: 'ready', children: refreshed });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              setLoadState(parent.id, { status: 'error', message });
            }
          }
        }
        // One tree opens per pointer: the first owning root (or `rootId`).
        break;
      }

      return leaves;
    },
    // `setLoadState` is stable (useCallback []), so listing it doesn't
    // reintroduce identity churn. `state.loadStates` is deliberately read via
    // `loadStatesRef` instead of being a dep — see the ref's comment.
    [roots, loadChildren, setLoadState],
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
    invalidate,
  };
}

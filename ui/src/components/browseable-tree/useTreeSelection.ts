import { createContext, useCallback, useMemo, useRef, useState } from 'react';
import type { Browseable } from './types';

/**
 * useTreeSelection — ephemeral multi-selection for <BrowseableTree>.
 *
 * A second, orthogonal cursor to the URL-first *navigation* cursor
 * (`activePointer`/`activeKey`): the set of rows the user is about to act on.
 * Per CLAUDE.md, URL-first governs navigation; this selection is transient
 * operation state (like tree expansion) and is NEVER persisted or written to
 * the URL.
 *
 * Scope is a single root subtree: a select gesture in a different root clears
 * the prior selection first. Membership is keyed by `Browseable.selectionKey`
 * (the stable typeid / id), so rows surviving a refetch stay selected.
 */
export interface TreeSelectionApi {
  /** Number of selected rows. */
  count: number;
  /** The selected nodes (latest stored object per key). */
  selectedNodes: Browseable[];
  /** The root subtree the current selection is scoped to (null when empty). */
  scopeRootId: string | null;
  /** Is the row with this selection key currently selected? */
  isSelected: (key: string | undefined) => boolean;

  /** Register the flattened, in-render-order list of selectable rows currently
   *  visible under `rootId`. The tree calls this each time its expansion/load
   *  state changes; range + select-all read it. Stored in a ref (no re-render). */
  setVisibleOrder: (rootId: string, nodes: Browseable[]) => void;

  // --- gestures (called from row click handlers) ---------------------------
  /** Plain click: clear the set, prime this row as the range anchor + scope. */
  anchorAndClear: (node: Browseable, rootId: string) => void;
  /** Cmd/Ctrl-click: toggle this row's membership (re-scopes if needed). */
  toggle: (node: Browseable, rootId: string) => void;
  /** Shift-click: select the contiguous range anchor→node over the visible order. */
  selectRange: (node: Browseable, rootId: string) => void;
  /** Cmd/Ctrl+A: select every visible selectable row in the current scope. */
  selectAllInScope: () => void;
  /** Clear the entire selection. */
  clear: () => void;
}

interface SelectionState {
  /** key → node (latest object). */
  items: Map<string, Browseable>;
  /** The range anchor key — primed on plain/Cmd click, used by Shift-range. */
  anchorKey: string | null;
  scopeRootId: string | null;
}

const EMPTY: SelectionState = { items: new Map(), anchorKey: null, scopeRootId: null };

export function useTreeSelection(): TreeSelectionApi {
  const [state, setState] = useState<SelectionState>(EMPTY);
  // Per-root flattened visible-selectable order. Mutable ref — set during the
  // tree's render-driven effect, read at gesture time. No re-render needed.
  const visibleOrderRef = useRef<Map<string, Browseable[]>>(new Map());

  const setVisibleOrder = useCallback((rootId: string, nodes: Browseable[]) => {
    visibleOrderRef.current.set(rootId, nodes);
  }, []);

  const isSelected = useCallback(
    (key: string | undefined) => !!key && state.items.has(key),
    [state.items],
  );

  const anchorAndClear = useCallback((node: Browseable, rootId: string) => {
    const key = node.selectionKey;
    if (!key) return;
    // Plain click does NOT add to the set (so a normal open doesn't pop the
    // bulk bar); it only primes the anchor + scope for a subsequent range.
    setState({ items: new Map(), anchorKey: key, scopeRootId: rootId });
  }, []);

  const toggle = useCallback((node: Browseable, rootId: string) => {
    const key = node.selectionKey;
    if (!key) return;
    setState((prev) => {
      // Selecting into a different root clears the prior selection first.
      const items = prev.scopeRootId === rootId ? new Map(prev.items) : new Map<string, Browseable>();
      if (items.has(key)) items.delete(key);
      else items.set(key, node);
      return { items, anchorKey: key, scopeRootId: rootId };
    });
  }, []);

  const selectRange = useCallback((node: Browseable, rootId: string) => {
    const key = node.selectionKey;
    if (!key) return;
    setState((prev) => {
      // Fresh single select when there's no usable anchor in this root (different
      // scope, or anchor not in the current visible order).
      const single = (): SelectionState => ({ items: new Map([[key, node]]), anchorKey: key, scopeRootId: rootId });
      const order = prev.scopeRootId === rootId ? visibleOrderRef.current.get(rootId) ?? [] : [];
      const from = order.findIndex((n) => n.selectionKey === prev.anchorKey);
      const to = order.findIndex((n) => n.selectionKey === key);
      if (from === -1 || to === -1) return single();
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      const items = new Map<string, Browseable>();
      for (let i = lo; i <= hi; i++) {
        const n = order[i];
        if (n.selectionKey) items.set(n.selectionKey, n);
      }
      // Keep the original anchor so the range can be re-stretched.
      return { items, anchorKey: prev.anchorKey, scopeRootId: rootId };
    });
  }, []);

  const selectAllInScope = useCallback(() => {
    setState((prev) => {
      if (!prev.scopeRootId) return prev;
      const order = visibleOrderRef.current.get(prev.scopeRootId) ?? [];
      const items = new Map<string, Browseable>();
      for (const n of order) if (n.selectionKey) items.set(n.selectionKey, n);
      return { ...prev, items };
    });
  }, []);

  const clear = useCallback(() => setState(EMPTY), []);

  return useMemo<TreeSelectionApi>(
    () => ({
      count: state.items.size,
      selectedNodes: [...state.items.values()],
      scopeRootId: state.scopeRootId,
      isSelected,
      setVisibleOrder,
      anchorAndClear,
      toggle,
      selectRange,
      selectAllInScope,
      clear,
    }),
    [state, isSelected, setVisibleOrder, anchorAndClear, toggle, selectRange, selectAllInScope, clear],
  );
}

/**
 * Selection sharing channel. The `NavigatorPanel` owns the hook and provides
 * the api here so the header selection bar and the tree body (sibling regions)
 * read one selection. `null` (no provider, e.g. the popover BrowseableMenu, or
 * a navigator without a `bulkActions` resolver) ⇒ multi-select disabled and the
 * tree behaves exactly as before.
 */
export const TreeSelectionContext = createContext<TreeSelectionApi | null>(null);

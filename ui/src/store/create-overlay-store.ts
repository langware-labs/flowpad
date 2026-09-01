import { create, type StoreApi, type UseBoundStore } from 'zustand';

/**
 * State every global overlay store holds.
 *
 * `setOpen` exists so a Radix `<Dialog onOpenChange>` can be wired straight to
 * the store; closing through it clears the payload like `close()` does.
 */
export interface OverlayState<T> {
  open: boolean;
  /** What the opener passed. Null while closed. */
  payload: T | null;
  setOpen: (open: boolean) => void;
}

export interface OverlayStore<T> {
  useStore: UseBoundStore<StoreApi<OverlayState<T>>>;
  /** Imperative opener — call from anywhere, no hook needed. */
  open: T extends void ? () => void : (payload: T) => void;
  close: () => void;
  toggle: () => void;
}

/**
 * A global overlay's store, in one line.
 *
 * Wiki modal, file preview, run preview, harness login, activity progress and
 * Spotlight each hand-rolled the same zustand store: an `open` boolean, an
 * optional payload, and a trio of open/close/toggle setters that differed only
 * in naming. This is that store.
 *
 * Store-driven rather than URL-driven on purpose: the CLAUDE.md URL-first rule
 * governs tab / view / asset navigation, not transient overlays. What an
 * overlay OPENS is still URL-first.
 */
export function createOverlayStore<T = void>(): OverlayStore<T> {
  const useStore = create<OverlayState<T>>((set) => ({
    open: false,
    payload: null,
    setOpen: (open) => set(open ? { open: true } : { open: false, payload: null }),
  }));

  return {
    useStore,
    open: ((payload?: T) => useStore.setState({ open: true, payload: (payload ?? null) as T | null })) as OverlayStore<T>['open'],
    close: () => useStore.setState({ open: false, payload: null }),
    toggle: () => useStore.setState((s) => (s.open ? { open: false, payload: null } : { open: true })),
  };
}

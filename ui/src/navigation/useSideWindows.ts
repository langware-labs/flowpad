import { useCallback, useMemo } from 'react';
import { useDockNavigation } from './useDockNavigation';
import type { SideWindowsState } from '@src/lib/side-windows';

/**
 * URL-first controller for a dock's side windows. The open set + active id are
 * dock state (`?sideWindows=…&activeSideWindow=…`), read through
 * `DockPointer.sideWindows` and written by pushing a new dock — the URL is the
 * single writer, so open/close/select are back-button-restorable and
 * shareable. Every side-window surface (interactive terminal, markdown asset
 * editor) drives the shared `TabbedSideDrawer` through this one hook; ids are
 * opaque, view-specific strings the surface maps onto its own registry.
 */
export interface SideWindowsController {
  /** Ordered, de-duplicated open ids (raw — the surface filters to known ids). */
  windows: string[];
  /** Resolved active id (explicit stamp, else last-in-list), or null when empty. */
  active: string | null;
  /** Open `id` (append if not already open) and make it active. */
  open: (id: string) => void;
  /** Close `id`, falling active back to the new last-in-list. */
  close: (id: string) => void;
  /** Close every open window (collapse the drawer). */
  closeAll: () => void;
  /**
   * Keep only the ids in `allowed`, in one URL write. Race-free by
   * construction — the written set is a filter of the set just read — so a
   * surface pruning windows it cannot render never issues a navigation per id.
   */
  retain: (allowed: ReadonlySet<string>) => void;
  /** Make an already-open `id` active (no-op if not open). */
  select: (id: string) => void;
  /** Active+open → close; otherwise open+activate. */
  toggle: (id: string) => void;
}

export function useSideWindows(): SideWindowsController {
  const { navigation, currentDock } = useDockNavigation();

  // Parse the dock's side-windows once. `active` resolves to last-in-list when
  // not explicitly stamped — mirrors the default-active rule the serde uses, so
  // reads and writes stay symmetric.
  const { windows, active } = useMemo<{ windows: string[]; active: string | null }>(() => {
    const sw = currentDock?.sideWindows;
    const windows = sw?.windows ?? [];
    const explicit = sw?.active ?? null;
    const active =
      explicit && windows.includes(explicit) ? explicit : (windows[windows.length - 1] ?? null);
    return { windows, active };
  }, [currentDock]);

  const push = useCallback(
    (next: SideWindowsState) => {
      if (!currentDock) return;
      navigation.openDock(currentDock.withSideWindows(next));
    },
    [currentDock, navigation],
  );

  const open = useCallback(
    (id: string) => {
      const next = windows.includes(id) ? windows : [...windows, id];
      push({ windows: next, active: id });
    },
    [windows, push],
  );

  const close = useCallback(
    (id: string) => {
      const next = windows.filter((w) => w !== id);
      const nextActive = active === id ? (next[next.length - 1] ?? null) : active;
      push({ windows: next, active: nextActive });
    },
    [windows, active, push],
  );

  const closeAll = useCallback(() => {
    if (windows.length === 0) return;
    push({ windows: [], active: null });
  }, [windows, push]);

  const retain = useCallback(
    (allowed: ReadonlySet<string>) => {
      const next = windows.filter((w) => allowed.has(w));
      if (next.length === windows.length) return;
      const nextActive = active && allowed.has(active) ? active : (next[next.length - 1] ?? null);
      push({ windows: next, active: nextActive });
    },
    [windows, active, push],
  );

  const select = useCallback(
    (id: string) => {
      if (!windows.includes(id)) return;
      push({ windows, active: id });
    },
    [windows, push],
  );

  const toggle = useCallback(
    (id: string) => {
      if (active === id && windows.includes(id)) {
        const next = windows.filter((w) => w !== id);
        push({ windows: next, active: next[next.length - 1] ?? null });
        return;
      }
      const next = windows.includes(id) ? windows : [...windows, id];
      push({ windows: next, active: id });
    },
    [windows, active, push],
  );

  return { windows, active, open, close, closeAll, retain, select, toggle };
}

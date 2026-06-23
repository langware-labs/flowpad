import { create } from 'zustand';
import { ViewContext } from '@src/types/ViewContext';

/**
 * Viewer store — the current viewing context only.
 *
 * `currentContext` is a URL-derived param bag (`codeRef` path / `viewerOptions`
 * port / checkpointHash) that the body components read; `useActiveViewer` writes
 * it from `currentDock`. Everything else this store used to own is gone:
 * - header tab membership → the unified TabStrip (entity-backed `Tab`, URL-active);
 * - the overview-axis (`currentOverviewTab` / `viewStack`) → the body is the
 *   URL's `currentDock.viewType` (content-panel), with agent focus routed through
 *   `navigation.openDock` (docs/tab-management.md Part 0).
 */
export interface ViewerState {
  /** Current viewing context (path, port, checkpointHash, …) — URL-derived. */
  currentContext: ViewContext | null;
  /** Set current viewing context. */
  setCurrentContext: (context: ViewContext | null) => void;
}

export const useViewerStore = create<ViewerState>((set) => ({
  currentContext: null,
  setCurrentContext: (context) => set({ currentContext: context }),
}));

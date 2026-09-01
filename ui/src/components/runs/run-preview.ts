/**
 * The run-preview overlay's store and imperative opener.
 *
 * Store-driven rather than URL-driven on purpose: this is a transient overlay,
 * and the CLAUDE.md URL-first rule governs tab/view/asset navigation, not
 * overlays — the same carve-out `wiki-modal.ts` documents. What the overlay
 * OPENS is URL-first: its "Open" affordance closes itself and calls
 * `navigation.openDock(DockPointer.forProcessRuns(...))` like any other click.
 *
 * A preview is always SCOPED — you open "this process's runs" or "this flow's
 * runs", never the global list — which is the whole point: the surfaces that
 * previously offered `proc ⬈` threw you into a raw terminal for one process
 * with no way back to its siblings.
 */
import type { ProcessRunScope } from '@src/navigation/DockPointer';
import { createOverlayStore } from '@src/store/create-overlay-store';

export interface RunPreviewTarget {
  /** Narrows the list. Never empty — see the module doc. */
  scope: ProcessRunScope;
  /** Row to open on mount, when the caller already knows which run it means. */
  runId?: string | null;
  /** Shown as the overlay's title, e.g. the node or flow name. */
  title: string;
}

const store = createOverlayStore<RunPreviewTarget>();
export const useRunPreviewStore = store.useStore;

/** Open the run-preview overlay. The imperative entry point for call sites. */
export const openRunPreview = store.open;

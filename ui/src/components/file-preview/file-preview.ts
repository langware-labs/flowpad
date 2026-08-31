import type { TypeId } from '@sdk';
import { createOverlayStore } from '@src/store/create-overlay-store';

/**
 * Global store backing `openFilePreview(target)` — peek a file from anywhere
 * (a source-grounded interface block, a search hit, a stack frame).
 *
 * Store-driven, like the other global overlays (`openWikiModal`, `Spotlight`,
 * `ActivityProgressModalRoot`): the CLAUDE.md URL-first rule governs tab/view/
 * asset navigation, not transient overlays. See docs/wikitip.md for the
 * convention and docs/display-capabilities.md for where this surface sits.
 *
 * Hosting it globally rather than inside a caller also keeps the sheet out of
 * any one component's render cycle — mounted inside the markdown editor it
 * re-rendered on every selection change, which is how a load-window download
 * ended up firing repeatedly.
 */
export interface FilePreviewTarget {
  /** Absolute machine path of the file to peek at. */
  path: string;
  /** 1-indexed line to reveal and mark, if the caller named one. */
  line?: number;
  /** Entity the file is read through — normally the caller's compute node. */
  typeId: TypeId;
}

const store = createOverlayStore<FilePreviewTarget>();
export const useFilePreviewStore = store.useStore;
export const closeFilePreview = store.close;

/** Peek `target.path` in a sheet, scrolled to and marking `target.line`. */
export const openFilePreview = store.open;

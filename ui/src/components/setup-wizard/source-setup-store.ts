import type { DataSource } from '@sdk';
import { createOverlayStore } from '@src/store/create-overlay-store';

/**
 * Global store backing `openSourceSetup()` — a source's Setup button opens its setup from any surface
 * (a row, the stream inbox's strip, a hover list that unmounts as soon as the pointer leaves it).
 * Store-driven like the other global overlays; the URL-first rule governs tab/view/asset navigation,
 * not transient overlays.
 */
const store = createOverlayStore<{ source: DataSource }>();
export const useSourceSetupStore = store.useStore;
export const openSourceSetup = (source: DataSource) => store.open({ source });

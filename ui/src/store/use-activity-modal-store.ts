import { createOverlayStore } from './create-overlay-store';

/** The indexer's activity-progress modal — opened from the footer indicator. */
const store = createOverlayStore();
export const useActivityModalStore = store.useStore;
export const showActivityModal = store.open;

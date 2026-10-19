import { createOverlayStore } from './create-overlay-store';

/** The generic activity details modal — opened from the footer's activity pill. The
 *  payload is the root's address; the modal reads the live tree (or the receipt). */
const store = createOverlayStore<{ path: string; subject_entity: string | null }>();
export const useActivityDetailsStore = store.useStore;
export const showActivityDetails = store.open;

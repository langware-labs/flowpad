import { createOverlayStore } from '@src/store/create-overlay-store';

/** The Upgrade screen's overlay store. No payload: the screen reads the funding record. */
const store = createOverlayStore();
export const useUpgradeStore = store.useStore;
export const openUpgradeScreen: () => void = store.open;
export const closeUpgradeScreen = store.close;

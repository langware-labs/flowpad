import { createOverlayStore } from './create-overlay-store';

const store = createOverlayStore();
export const useSpotlightStore = store.useStore;
export const openSpotlight = store.open;
export const closeSpotlight = store.close;
export const toggleSpotlight = store.toggle;

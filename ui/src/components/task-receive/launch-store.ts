import type { LaunchPlan } from '@src/pages/entry/launch-plan';
import { createOverlayStore } from '@src/store/create-overlay-store';

/**
 * The launch a link asked for, while it runs (`LaunchDialog`).
 *
 * A store rather than the deep-link handler's own state because other overlays have to know a
 * launch is on screen: the launch is what the person asked for, so anything the app wants to put
 * in front of them by itself (first-run setup, a shared-project offer) waits until it is done.
 */
const store = createOverlayStore<LaunchPlan>();
export const useLaunchStore = store.useStore;
export const openLaunch = store.open;
export const closeLaunch = store.close;

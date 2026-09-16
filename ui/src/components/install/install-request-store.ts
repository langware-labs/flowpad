import { createOverlayStore } from '@src/store/create-overlay-store';
import type { InstallRequest } from '@sdk';

/**
 * The Add-asset dialog's store. Opened by the `install_request` ui_command the
 * desktop backend broadcasts when the hub relays a one-click install; the
 * payload is the published row (typeid + origin + provenance). Store-driven,
 * like every transient overlay; what the dialog OPENS afterwards is URL-first.
 */
export const installRequestStore = createOverlayStore<InstallRequest>();
export const useInstallRequestStore = installRequestStore.useStore;
export const openInstallRequest = installRequestStore.open;
export const closeInstallRequest = installRequestStore.close;

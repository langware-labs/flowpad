import { isHubOnly } from '@src/navigation/hub-runtime';
import { createOverlayStore } from '@src/store/create-overlay-store';

/**
 * Global store backing `openHarnessLoginModal()` — pops the "Harness login
 * required" modal from anywhere (startup gate, footer warning). Store-driven
 * like the other global overlays (`WikiModalRoot`, `Spotlight`); the
 * URL-first rule governs tab/view/asset navigation, not transient overlays.
 */

/**
 * The harness that just told us, in its own words, that it is signed out — the
 * reason this modal opened. Carried as the overlay's payload because throwing
 * it away is the whole bug: the modal used to open ON "Not logged in · Please
 * run /login" and then render whatever `login_state` last said, which after a
 * device login that has since been revoked is a green "Signed in" contradicting
 * the very error that summoned it. A denial from the CLI outranks any cached
 * state.
 *
 * `createOverlayStore` clears the payload on close, which is exactly the
 * lifetime this needs: it describes one turn, not the harness forever, so a
 * completed sign-in must not still show it.
 */
export interface HarnessSignedOut {
  kind: string;
  message: string;
}

const store = createOverlayStore<HarnessSignedOut>();
export const useHarnessLoginStore = store.useStore;

export function openHarnessLoginModal(signedOut?: HarnessSignedOut): void {
  // Desktop-only overlay — never surfaced in hub mode.
  if (isHubOnly()) return;
  store.open(signedOut);
}

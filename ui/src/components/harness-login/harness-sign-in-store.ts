import { isHubOnly } from '@src/navigation/hub-runtime';
import { createOverlayStore } from '@src/store/create-overlay-store';

/**
 * Global store backing `openHarnessSignIn(kind)` — the ONE place a vendor device sign-in runs.
 *
 * It used to be a sub-view of the Assistants & keys modal, which made it two screens away from
 * the LLM sources page that sends people to sign in, and the page and the modal pointed at each
 * other. Now a Signed-out pill on the modal row and the sources page's "Sign in" open the same
 * small dialog, and both lists stay lists.
 *
 * The payload is WHICH harness, nothing else: why it is signed out is the backend's
 * `Capability.login_denied` / `login_message`, read off the watched entity (see the modal
 * store's note on why a copied reason outlives the login that disproves it).
 */
export interface HarnessSignInPayload {
  /** Capability kind, e.g. `harness.claude.cli`. */
  kind: string;
}

const store = createOverlayStore<HarnessSignInPayload>();
export const useHarnessSignInStore = store.useStore;
export const closeHarnessSignIn = store.close;

export function openHarnessSignIn(kind: string): void {
  // Desktop-only overlay — never surfaced in hub mode.
  if (isHubOnly()) return;
  store.open({ kind });
}

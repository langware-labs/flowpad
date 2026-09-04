import { isHubOnly } from '@src/navigation/hub-runtime';
import { createOverlayStore } from '@src/store/create-overlay-store';

/**
 * Global store backing `openHarnessLoginModal()` — pops the "Harness login
 * required" modal from anywhere (startup gate, footer warning). Store-driven
 * like the other global overlays (`WikiModalRoot`, `Spotlight`); the
 * URL-first rule governs tab/view/asset navigation, not transient overlays.
 *
 * Payload-less on purpose. WHY the harness is signed out is the backend's
 * `Capability.login_denied` / `login_message`, which the modal reads off the
 * watched entity — see `HarnessDetail`. Carrying it here as well gave the fact
 * two homes and only one of them could expire: the backend retracts the refusal
 * on a completed login, a verified probe or an explicit Test and broadcasts the
 * retraction, while an overlay payload lives until the overlay closes. That
 * copy outlived the login that disproved it and pinned the modal to a red "Not
 * signed in" over a harness that had just authenticated — the same lie the
 * refusal exists to prevent, pointing the other way.
 */
const store = createOverlayStore();
export const useHarnessLoginStore = store.useStore;

export function openHarnessLoginModal(): void {
  // Desktop-only overlay — never surfaced in hub mode.
  if (isHubOnly()) return;
  store.open();
}

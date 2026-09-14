import { isHubOnly } from '@src/navigation/hub-runtime';
import { createOverlayStore } from '@src/store/create-overlay-store';

/**
 * Global store backing `openHarnessLoginModal()` — pops the "Harness login
 * required" modal from anywhere (startup gate, footer warning). Store-driven
 * like the other global overlays (`WikiModalRoot`, `Spotlight`); the
 * URL-first rule governs tab/view/asset navigation, not transient overlays.
 *
 * The payload carries WHICH harness to open on, and nothing else. WHY a harness
 * is signed out stays out of it: that is the backend's
 * `Capability.login_denied` / `login_message`, which the modal reads off the
 * watched entity — see `HarnessDetail`. Carrying the reason here as well gave
 * the fact two homes and only one of them could expire: the backend retracts the
 * refusal on a completed login, a verified probe or an explicit Test and
 * broadcasts the retraction, while an overlay payload lives until the overlay
 * closes. That copy outlived the login that disproved it and pinned the modal to
 * a red "Not signed in" over a harness that had just authenticated — the same lie
 * the refusal exists to prevent, pointing the other way.
 *
 * `kind` is safe where a reason was not, and the difference is expiry: a harness
 * the opener named cannot become the wrong harness while the modal is up, so
 * there is no retraction for the copy to miss. It exists because the LLM setup
 * chooser (`/dock/llm-setup`) opens this modal from a tile the user already
 * picked a vendor on, and landing them on the list to pick it a second time
 * reads as the click not having worked.
 */
export interface HarnessLoginPayload {
  /** Capability kind to open directly, e.g. `harness.claude.cli`. Omit for the list. */
  kind?: string;
}

const store = createOverlayStore<HarnessLoginPayload>();
export const useHarnessLoginStore = store.useStore;

export function openHarnessLoginModal(payload: HarnessLoginPayload = {}): void {
  // Desktop-only overlay — never surfaced in hub mode.
  if (isHubOnly()) return;
  store.open(payload);
}

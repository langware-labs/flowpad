import { isHubOnly } from '@src/navigation/hub-runtime';
import { createOverlayStore } from '@src/store/create-overlay-store';

/**
 * Global store backing `openHarnessLoginModal()` — pops the "Harness login
 * required" modal from anywhere (startup gate, footer warning). Store-driven
 * like the other global overlays (`WikiModalRoot`, `Spotlight`); the
 * URL-first rule governs tab/view/asset navigation, not transient overlays.
 */
const store = createOverlayStore();
export const useHarnessLoginStore = store.useStore;

export function openHarnessLoginModal(): void {
  // Desktop-only overlay — never surfaced in hub mode.
  if (isHubOnly()) return;
  store.open();
}

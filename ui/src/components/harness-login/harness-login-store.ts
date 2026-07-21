import { create } from 'zustand';
import { isHubOnly } from '@src/navigation/hub-runtime';

/**
 * Global store backing `openHarnessLoginModal()` — pops the "Harness login
 * required" modal from anywhere (startup gate, footer warning). Store-driven
 * like the other global overlays (`WikiModalRoot`, `Spotlight`); the
 * URL-first rule governs tab/view/asset navigation, not transient overlays.
 */
interface HarnessLoginStore {
  open: boolean;
  setOpen: (v: boolean) => void;
}

export const useHarnessLoginStore = create<HarnessLoginStore>((set) => ({
  open: false,
  setOpen: (v) => set({ open: v }),
}));

export function openHarnessLoginModal(): void {
  // Desktop-only overlay — never surfaced in hub mode.
  if (isHubOnly()) return;
  useHarnessLoginStore.getState().setOpen(true);
}

// One-time "don't nag me again" flag for the STARTUP auto-open only. A user who
// has dismissed the login modal once should not have it re-open on every app
// mount (the footer warning still surfaces the partial/none-signed-in state and
// re-opens the modal on click — an explicit user action, never suppressed). This
// is the historical `DesktopSetupModal` contract that the harness-login gate
// dropped; dozens of manual-regression tests dismiss the modal via this key.
const SETUP_SEEN_KEY = 'llm-setup-modal-seen';

export function hasDismissedHarnessLogin(): boolean {
  try {
    return localStorage.getItem(SETUP_SEEN_KEY) === 'true';
  } catch {
    return false;
  }
}

export function markHarnessLoginDismissed(): void {
  try {
    localStorage.setItem(SETUP_SEEN_KEY, 'true');
  } catch {
    /* storage unavailable — best-effort suppression only */
  }
}

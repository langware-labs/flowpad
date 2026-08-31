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
  /**
   * The harness that just told us, in its own words, that it is signed out —
   * the reason this modal opened. Kept because throwing it away is the whole
   * bug: the modal used to open ON "Not logged in · Please run /login" and then
   * render whatever `login_state` last said, which after a device login that
   * has since been revoked is a green "Signed in" contradicting the very error
   * that summoned it. A denial from the CLI outranks any cached state.
   *
   * Cleared when the modal closes: it describes one turn, not the harness
   * forever, and a completed sign-in must not still show it.
   */
  signedOut: { kind: string; message: string } | null;
  setOpen: (v: boolean) => void;
}

export const useHarnessLoginStore = create<HarnessLoginStore>((set) => ({
  open: false,
  signedOut: null,
  setOpen: (v) => set(v ? { open: true } : { open: false, signedOut: null }),
}));

export function openHarnessLoginModal(signedOut?: { kind: string; message: string }): void {
  // Desktop-only overlay — never surfaced in hub mode.
  if (isHubOnly()) return;
  useHarnessLoginStore.setState({ open: true, signedOut: signedOut ?? null });
}

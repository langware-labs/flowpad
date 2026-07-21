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

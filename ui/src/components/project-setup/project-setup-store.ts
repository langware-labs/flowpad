import { createOverlayStore } from '@src/store/create-overlay-store';

/**
 * Global store backing `openProjectSetup()` — the footer's "Project setup required" warning opens
 * the project's setup wizard from anywhere. Store-driven like the other global overlays; the
 * URL-first rule governs tab/view/asset navigation, not transient overlays.
 */
export interface ProjectSetupPayload {
  projectId: string;
  projectName: string;
}

const store = createOverlayStore<ProjectSetupPayload>();
export const useProjectSetupStore = store.useStore;
export const openProjectSetup = store.open;

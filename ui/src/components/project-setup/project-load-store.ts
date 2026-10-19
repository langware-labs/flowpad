import type { ProjectLoadResult } from '@sdk';
import { createOverlayStore } from '@src/store/create-overlay-store';

export interface ProjectLoadPayload {
  projectId: string;
  projectName: string;
  initial: ProjectLoadResult;
}
const store = createOverlayStore<ProjectLoadPayload>();
export const useProjectLoadStore = store.useStore;
export const openProjectLoad = store.open;

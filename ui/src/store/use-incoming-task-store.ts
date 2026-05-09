import { create } from 'zustand';

export interface IncomingTaskParams {
  taskId: string;
  taskTitle: string;
  senderName: string;
  /** Repo URL (from REPO attachment or notification metadata). When absent the UI navigates directly to the task. */
  projectUrl?: string;
  branch?: string;
  repoId?: string;
}

interface IncomingTaskState {
  pendingTask: IncomingTaskParams | null;
  setPendingTask: (params: IncomingTaskParams | null) => void;
}

export const useIncomingTaskStore = create<IncomingTaskState>((set) => ({
  pendingTask: null,
  setPendingTask: (params) => set({ pendingTask: params }),
}));

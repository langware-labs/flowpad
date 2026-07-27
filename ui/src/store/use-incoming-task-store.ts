import { create } from 'zustand';
import type { GitOrigin } from '@sdk/models/GitOrigin';

export interface IncomingTaskParams {
  taskId: string;
  taskTitle: string;
  senderName: string;
  /** Git origin reference. When absent the UI navigates directly to the task. */
  gitOrigin?: GitOrigin | null;
}

interface IncomingTaskState {
  pendingTask: IncomingTaskParams | null;
  setPendingTask: (params: IncomingTaskParams | null) => void;
}

export const useIncomingTaskStore = create<IncomingTaskState>((set) => ({
  pendingTask: null,
  setPendingTask: (params) => set({ pendingTask: params }),
}));

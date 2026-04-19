import { create } from 'zustand';

export interface IncomingTaskParams {
  taskId: string;
  taskTitle: string;
  senderName: string;
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

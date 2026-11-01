import { create } from 'zustand';
import type { NotificationData } from './types';

/** The notification whose details popup is open (`ErrorDetailsDialog`), or null. */
interface ErrorDetailsState {
  shown: NotificationData | null;
  open: (data: NotificationData) => void;
  close: () => void;
}

export const useErrorDetailsStore = create<ErrorDetailsState>((set) => ({
  shown: null,
  open: (shown) => set({ shown }),
  close: () => set({ shown: null }),
}));

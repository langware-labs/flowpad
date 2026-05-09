import { create } from 'zustand';

interface InboxStore {
  unreadCount: number;
  setUnreadCount: (count: number) => void;
}

export const useInboxStore = create<InboxStore>((set) => ({
  unreadCount: 0,
  setUnreadCount: (count) => set({ unreadCount: count }),
}));

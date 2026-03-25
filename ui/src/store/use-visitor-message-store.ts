import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface VisitorMessageState {
  messageCount: number;
  messageCountVisitorId: string | null;
  incrementMessageCount: (visitorId: string) => void;
  resetMessageCount: () => void;
}

export const useVisitorMessageStore = create<VisitorMessageState>()(
  persist(
    (set) => ({
      messageCount: 0,
      messageCountVisitorId: null,
      incrementMessageCount: (visitorId: string) =>
        set((state) => {
          const currentMessageCount = state.messageCountVisitorId == visitorId ? state.messageCount : 0;
          const messageCount = currentMessageCount + 1;
          return { messageCount, messageCountVisitorId: visitorId };
        }),
      resetMessageCount: () => set({ messageCount: 0, messageCountVisitorId: null }),
    }),
    {
      name: 'visitor-message-count',
    },
  ),
);

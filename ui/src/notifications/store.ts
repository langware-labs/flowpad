import { create } from 'zustand';
import { ViewType } from '@src/types/ViewType';
import type { NotificationData } from './types';

/**
 * Persistent badge store — holds the `category`-bearing notifications that show
 * in the sidebar feed (was `@src/store/use-notification-store`). Keyed by `id`,
 * so a repeat emit upserts in place (the dedupe that used to compare
 * title+navigationPath). Transient toasts do NOT live here — they go straight
 * to sonner via `notify()`.
 */
interface BadgeState {
  byId: Record<string, NotificationData>;
  upsert: (n: NotificationData) => void;
  remove: (id: string) => void;
  clearCategory: (category: ViewType) => void;
  clearAll: () => void;
}

export const useBadgeStore = create<BadgeState>((set) => ({
  byId: {},
  upsert: (n) => set((s) => ({ byId: { ...s.byId, [n.id]: n } })),
  remove: (id) =>
    set((s) => {
      if (!(id in s.byId)) return s;
      const next = { ...s.byId };
      delete next[id];
      return { byId: next };
    }),
  clearCategory: (category) =>
    set((s) => ({
      byId: Object.fromEntries(Object.entries(s.byId).filter(([, n]) => n.category !== category)),
    })),
  clearAll: () => set({ byId: {} }),
}));

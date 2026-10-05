import { create } from 'zustand';
import type { NotificationData } from './types';

/**
 * The `location: 'center'` notifications: shown one at a time, in order, as a blocking dialog
 * (`NotificationOutlet`). Keyed by `id` like every other surface, so a repeat emit replaces in
 * place and `notify.dismiss(id)` removes it.
 */
interface CenterState {
  queue: NotificationData[];
  show: (n: NotificationData) => void;
  remove: (id: string) => void;
}

export const useCenterStore = create<CenterState>((set) => ({
  queue: [],
  show: (n) =>
    set((s) =>
      s.queue.some((q) => q.id === n.id)
        ? { queue: s.queue.map((q) => (q.id === n.id ? n : q)) }
        : { queue: [...s.queue, n] },
    ),
  remove: (id) =>
    set((s) => (s.queue.some((q) => q.id === id) ? { queue: s.queue.filter((q) => q.id !== id) } : s)),
}));

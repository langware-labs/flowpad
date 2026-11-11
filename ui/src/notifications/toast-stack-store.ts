import { create } from 'zustand';

/** How many toasts sonner draws at once; older ones wait hidden behind them. */
const VISIBLE_TOASTS = 3;
/** "Clear all" appears once the stack is taller than this. */
const CLEAR_ALL_ABOVE = 2;

/**
 * The ids of the corner toasts on screen, oldest first. `notify` adds one when it shows a toast and
 * removes it when the toast goes (×, swipe, timer), so the stack can offer one "Clear all".
 */
interface ToastStackState {
  ids: string[];
  add: (id: string) => void;
  remove: (id: string) => void;
}

export const useToastStackStore = create<ToastStackState>((set) => ({
  ids: [],
  add: (id) => set((s) => (s.ids.includes(id) ? s : { ids: [...s.ids, id] })),
  remove: (id) => set((s) => (s.ids.includes(id) ? { ids: s.ids.filter((x) => x !== id) } : s)),
}));

/** The toast drawn at the top of the stack — where "Clear all" sits — or null when the stack is short. */
export function clearAllHost(ids: string[]): string | null {
  if (ids.length <= CLEAR_ALL_ABOVE) return null;
  return ids[Math.max(0, ids.length - VISIBLE_TOASTS)];
}

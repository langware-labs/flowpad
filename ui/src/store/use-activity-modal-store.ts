import { create } from 'zustand';

interface ActivityModalStore {
  open: boolean;
  setOpen: (v: boolean) => void;
  show: () => void;
  hide: () => void;
}

export const useActivityModalStore = create<ActivityModalStore>((set) => ({
  open: false,
  setOpen: (v) => set({ open: v }),
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

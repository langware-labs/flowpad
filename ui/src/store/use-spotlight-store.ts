import { create } from 'zustand';

interface SpotlightStore {
  open: boolean;
  openSpotlight: () => void;
  closeSpotlight: () => void;
  toggleSpotlight: () => void;
}

export const useSpotlightStore = create<SpotlightStore>((set) => ({
  open: false,
  openSpotlight: () => set({ open: true }),
  closeSpotlight: () => set({ open: false }),
  toggleSpotlight: () => set((s) => ({ open: !s.open })),
}));

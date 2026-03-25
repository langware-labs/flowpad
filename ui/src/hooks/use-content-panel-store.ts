import { TabTypeWithoutOverview } from '@src/hooks/flow-hooks';
import { create } from 'zustand';

interface ContentPanelState {
  addTab: ((type: TabTypeWithoutOverview, pinned?: boolean, setActive?: boolean) => void) | undefined;
  setAddTab: (addTab: (type: TabTypeWithoutOverview, pinned?: boolean, setActive?: boolean) => void) => void;
}

export const useContentPanelStore = create<ContentPanelState>()((set) => ({
  addTab: undefined,
  setAddTab: (addTab) => set({ addTab }),
}));

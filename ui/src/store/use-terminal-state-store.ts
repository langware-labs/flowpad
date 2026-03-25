import { create } from 'zustand';

interface TerminalStateStore {
  activeSessionId: string;
  setActiveSessionId: (sessionId: string) => void;
}

export const useTerminalStateStore = create<TerminalStateStore>()((set) => ({
  activeSessionId: '',
  setActiveSessionId: (sessionId: string) => set({ activeSessionId: sessionId }),
}));

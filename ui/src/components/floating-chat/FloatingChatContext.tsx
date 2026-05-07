import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { FloatingChatWindow } from './FloatingChatWindow';

interface FloatingChatContextValue {
  open: boolean;
  toggle: () => void;
  openChat: () => void;
  closeChat: () => void;
}

const FloatingChatContext = createContext<FloatingChatContextValue | null>(null);

export function FloatingChatProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const openChat = useCallback(() => setOpen(true), []);
  const closeChat = useCallback(() => setOpen(false), []);

  const value = useMemo<FloatingChatContextValue>(
    () => ({ open, toggle, openChat, closeChat }),
    [open, toggle, openChat, closeChat],
  );

  return (
    <FloatingChatContext.Provider value={value}>
      {children}
      <FloatingChatWindow />
    </FloatingChatContext.Provider>
  );
}

export function useFloatingChat(): FloatingChatContextValue {
  const ctx = useContext(FloatingChatContext);
  if (!ctx) {
    throw new Error('useFloatingChat must be used inside <FloatingChatProvider>');
  }
  return ctx;
}

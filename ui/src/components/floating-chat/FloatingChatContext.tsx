import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { FloatingChatWindow } from './FloatingChatWindow';

export interface TriggerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FloatingChatContextValue {
  open: boolean;
  triggerRect: TriggerRect | null;
  toggle: (rect?: TriggerRect | null) => void;
  openChat: (rect?: TriggerRect | null) => void;
  closeChat: () => void;
}

const FloatingChatContext = createContext<FloatingChatContextValue | null>(null);

export function FloatingChatProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [triggerRect, setTriggerRect] = useState<TriggerRect | null>(null);

  const openChat = useCallback((rect?: TriggerRect | null) => {
    if (rect) setTriggerRect(rect);
    setOpen(true);
  }, []);
  const closeChat = useCallback(() => setOpen(false), []);
  const toggle = useCallback(
    (rect?: TriggerRect | null) => {
      if (rect) setTriggerRect(rect);
      setOpen((v) => !v);
    },
    [],
  );

  const value = useMemo<FloatingChatContextValue>(
    () => ({ open, triggerRect, toggle, openChat, closeChat }),
    [open, triggerRect, toggle, openChat, closeChat],
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

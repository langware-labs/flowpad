import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export interface TriggerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FloatingChatContextValue {
  open: boolean;
  triggerRect: TriggerRect | null;
  /**
   * True when the initial `open` value was restored from a previous session
   * (i.e. the user reloaded with the chat open). The window uses this to skip
   * the entrance animation on the first paint — no trigger rect to animate
   * from after a refresh.
   */
  restoredFromStorage: boolean;
  toggle: (rect?: TriggerRect | null) => void;
  openChat: (rect?: TriggerRect | null) => void;
  closeChat: () => void;
}

const FloatingChatContext = createContext<FloatingChatContextValue | null>(null);

const OPEN_STORAGE_KEY = 'flowpad.floatingChat.open';

function loadOpen(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function FloatingChatProvider({ children }: { children: React.ReactNode }) {
  const initialOpen = useMemo(() => loadOpen(), []);
  const [open, setOpen] = useState(initialOpen);
  const [triggerRect, setTriggerRect] = useState<TriggerRect | null>(null);

  // Persist on every change so a reload restores the user's last state.
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0');
    } catch {
      // ignore quota / private mode
    }
  }, [open]);

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
    () => ({ open, triggerRect, restoredFromStorage: initialOpen, toggle, openChat, closeChat }),
    [open, triggerRect, initialOpen, toggle, openChat, closeChat],
  );

  // The actual <FloatingChatWindow /> is mounted from a layout route inside
  // the router (see `router.tsx`'s root layout) — NOT here. The window's
  // descendants (AssetRow, MessageComposer, …) call react-router hooks like
  // `useNavigate()`, which throw when the component is rendered as a sibling
  // of <RouterProvider>. Keeping the provider at the App level preserves
  // open/close state across route changes; rendering the window below the
  // RouterProvider gives its descendants the Router context they need.
  return (
    <FloatingChatContext.Provider value={value}>
      {children}
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

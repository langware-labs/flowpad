import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Layout } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { useUiActionRequest } from '@src/navigation/ui-actions';
import {
  ASSISTANT_ALIVE_TTL_MS,
  ASSISTANT_CHAT_PARAM,
  openAssistantChannel,
  type AssistantChannelMessage,
} from './assistant-channel';

export interface TriggerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A prompt handed to the assistant from code, for the context at `url`. */
export interface PendingAsk {
  text: string;
  files?: File[];
  /** The dock URL the ask was made on — the chat it belongs to. */
  url: string;
  nonce: number;
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
  /**
   * Open the assistant on the CURRENT page's chat and send `text` (with
   * `files`) as if the user typed it. Goes to the popped-out assistant when
   * one is open.
   */
  ask: (text: string, opts?: { files?: File[]; rect?: TriggerRect | null }) => void;
  pendingAsk: PendingAsk | null;
  consumeAsk: (nonce: number) => void;
  /** A popped-out assistant window is alive; the floating chat stays closed. */
  popoutAlive: boolean;
  /** Pop the chat out; `chatUrl` is the page whose chat is showing, so the window opens on it. */
  popOut: (chatUrl?: string | null) => void;
  /** The main window reports where it is, for a popout following it. */
  publishDock: (url: string) => void;
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

  // ── The popped-out assistant: heartbeats say it is alive; `dock` follows us.
  const [popoutAlive, setPopoutAlive] = useState(false);
  const popoutAliveRef = useRef(false);
  const lastDockUrlRef = useRef<string | null>(null);
  const channelRef = useRef<ReturnType<typeof openAssistantChannel> | null>(null);
  useEffect(() => {
    let expiry: ReturnType<typeof setTimeout> | null = null;
    const setAlive = (alive: boolean) => {
      popoutAliveRef.current = alive;
      setPopoutAlive(alive);
    };
    const channel = openAssistantChannel((msg: AssistantChannelMessage) => {
      if (msg.kind === 'alive' || msg.kind === 'hello') {
        if (expiry) clearTimeout(expiry);
        expiry = setTimeout(() => setAlive(false), ASSISTANT_ALIVE_TTL_MS);
        if (!popoutAliveRef.current) setAlive(true);
        // A popout that just opened asks where we are.
        if (msg.kind === 'hello' && lastDockUrlRef.current) {
          channelRef.current?.post({ kind: 'dock', url: lastDockUrlRef.current });
        }
      } else if (msg.kind === 'bye') {
        if (expiry) clearTimeout(expiry);
        setAlive(false);
      }
    });
    channelRef.current = channel;
    return () => {
      if (expiry) clearTimeout(expiry);
      channel.close();
      channelRef.current = null;
    };
  }, []);

  const publishDock = useCallback((url: string) => {
    lastDockUrlRef.current = url;
    if (popoutAliveRef.current) channelRef.current?.post({ kind: 'dock', url });
  }, []);

  const openChat = useCallback((rect?: TriggerRect | null) => {
    if (popoutAliveRef.current) {
      channelRef.current?.post({ kind: 'focus' });
      return;
    }
    if (rect) setTriggerRect(rect);
    setOpen(true);
  }, []);
  const closeChat = useCallback(() => setOpen(false), []);
  // "ask the assistant" (smart navigation): the same chat its button opens.
  useUiActionRequest(['assistant-chat'], () => openChat());
  const toggle = useCallback(
    (rect?: TriggerRect | null) => {
      if (popoutAliveRef.current) {
        channelRef.current?.post({ kind: 'focus' });
        return;
      }
      if (rect) setTriggerRect(rect);
      setOpen((v) => !v);
    },
    [],
  );

  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const ask = useCallback(
    (text: string, opts?: { files?: File[]; rect?: TriggerRect | null }) => {
      const url = `${window.location.pathname}${window.location.search}`;
      if (popoutAliveRef.current) {
        channelRef.current?.post({ kind: 'ask', text, files: opts?.files, url });
        channelRef.current?.post({ kind: 'focus' });
        return;
      }
      setPendingAsk({ text, files: opts?.files, url, nonce: Date.now() });
      openChat(opts?.rect);
    },
    [openChat],
  );
  const consumeAsk = useCallback((nonce: number) => {
    setPendingAsk((prev) => (prev?.nonce === nonce ? null : prev));
  }, []);

  const popOut = useCallback((chatUrl?: string | null) => {
    const win = new DockPointer(
      ViewType.ASSISTANT,
      undefined,
      chatUrl ? { [ASSISTANT_CHAT_PARAM]: chatUrl } : undefined,
      Layout.WIN,
    );
    window.open(`${window.location.origin}${win.toUrl(window.location.pathname)}`, '_blank');
    setOpen(false);
  }, []);

  const value = useMemo<FloatingChatContextValue>(
    () => ({
      open,
      triggerRect,
      restoredFromStorage: initialOpen,
      toggle,
      openChat,
      closeChat,
      ask,
      pendingAsk,
      consumeAsk,
      popoutAlive,
      popOut,
      publishDock,
    }),
    [open, triggerRect, initialOpen, toggle, openChat, closeChat, ask, pendingAsk, consumeAsk, popoutAlive, popOut, publishDock],
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

/** The provider's value, or null outside it — for surfaces that only OFFER the assistant. */
export function useOptionalFloatingChat(): FloatingChatContextValue | null {
  return useContext(FloatingChatContext);
}

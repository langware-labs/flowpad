import { createContext, useContext } from 'react';

/**
 * The floating chat's context object and the hooks that read it — apart from the
 * provider on purpose. A module that exports a component AND hooks cannot be
 * hot-swapped in place: the dev server re-runs it alone, then reloads its
 * importers a moment later, and in between the mounted provider serves a NEW
 * context while the window and the button still read the old one — "must be used
 * inside <FloatingChatProvider>" under a provider that is plainly there. Kept
 * here, the context is created once and outlives every edit to the provider.
 */

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

export interface FloatingChatContextValue {
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

export const FloatingChatContext = createContext<FloatingChatContextValue | null>(null);

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

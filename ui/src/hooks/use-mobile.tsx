import { useSyncExternalStore } from 'react';
import { MOBILE_QUERY } from './mobile-query';

/**
 * THE mobile flag — one definition for the whole frontend. Mobile = the phone layout: narrower than
 * Tailwind's `md` (768px), or a phone on its side (a short touch screen) — the same line every `max-md:`
 * class draws (tailwind.config.ts), so JS and CSS never disagree.
 * One query (`MOBILE_QUERY`) answers every reader; don't add another query, breakpoint or touch check.
 *
 *  - in a component: `useIsMobile()` (re-renders when it flips)
 *  - anywhere else (handlers, loaders, plain functions): `isMobile()`
 */
export { MOBILE_QUERY };

// One MediaQueryList and one real listener for every reader, however many components subscribe.
// Rebuilt only if `window.matchMedia` itself is swapped (a test's stub).
let source: typeof window.matchMedia | undefined;
let mql: MediaQueryList | null = null;
let mobile = false;
const readers = new Set<() => void>();

function current(): MediaQueryList | null {
  const mm = typeof window !== 'undefined' ? window.matchMedia : undefined;
  if (mm !== source) {
    source = mm;
    mql = mm ? mm.call(window, MOBILE_QUERY) : null;
    mql?.addEventListener?.('change', () => {
      mobile = !!mql?.matches;
      readers.forEach((r) => r());
    });
  }
  mobile = !!mql?.matches;
  return mql;
}

export function isMobile(): boolean {
  current();
  return mobile;
}

function subscribe(onChange: () => void): () => void {
  current();
  readers.add(onChange);
  return () => readers.delete(onChange);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, isMobile, () => false);
}

/** Does this key press send a chat-style message? Plain Enter on desktop. On mobile Enter is the newline
 *  key — a touch keyboard has no Shift+Enter to reach for — and the send button sends. */
export function submitOnEnter(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'Enter' && !e.shiftKey && !isMobile();
}

import { useEffect, useState } from 'react';
import { defineGlobal } from '@sdk/utils';

/**
 * Which view an interactive agent tab shows.
 *  - `null`     → follow View mode (Standard ⇒ chat UI, Advanced ⇒ terminal).
 *  - `'chat'`   → force the chat UI regardless of View mode.
 *  - `'terminal'` → force the xterm terminal regardless of View mode.
 *
 * The user flips it from the bottom-ribbon toggle; once set, it is persisted to
 * localStorage and **takes priority** over the View-mode default until cleared.
 */
export type ChatUiOverride = 'chat' | 'terminal' | null;

declare global {
  interface Window {
    setChatUi: (val: ChatUiOverride | boolean) => void;
    getChatUi: () => ChatUiOverride;
  }
}

const KEY = 'chatUiOverride';
const LEGACY_KEY = 'chatUiMode';

function load(): ChatUiOverride {
  const v = localStorage.getItem(KEY);
  if (v === 'chat' || v === 'terminal') return v;
  // Migrate the legacy boolean flag: true meant "force chat".
  if (localStorage.getItem(LEGACY_KEY) === 'true') return 'chat';
  return null;
}

let _override: ChatUiOverride = load();
const _listeners = new Set<(val: ChatUiOverride) => void>();

export function setChatUiOverride(val: ChatUiOverride): void {
  _override = val;
  if (val === null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, val);
  localStorage.removeItem(LEGACY_KEY);
  _listeners.forEach((fn) => fn(val));
}

export function getChatUiOverride(): ChatUiOverride {
  return _override;
}

// Console helper, back-compatible with the old boolean form:
//   setChatUi('chat' | 'terminal' | null) — explicit; setChatUi(true|false) — legacy.
defineGlobal('setChatUi', (val: ChatUiOverride | boolean) => {
  setChatUiOverride(val === true ? 'chat' : val === false ? null : val);
});
defineGlobal('getChatUi', getChatUiOverride);

export function useChatUiOverride(): ChatUiOverride {
  const [override, setState] = useState(_override);
  useEffect(() => {
    _listeners.add(setState);
    return () => {
      _listeners.delete(setState);
    };
  }, []);
  return override;
}

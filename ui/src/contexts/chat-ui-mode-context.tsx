import { instancePreferences, PrefKey } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { defineGlobal } from '@sdk/utils';

/**
 * Which view an interactive agent tab shows.
 *  - `null`     → follow View mode (Standard ⇒ chat UI, Advanced ⇒ terminal).
 *  - `'chat'`   → force the chat UI regardless of View mode.
 *  - `'terminal'` → force the xterm terminal regardless of View mode.
 *
 * Owned by prefMan (`preferences.ui.chat_ui_mode`, a boot key). Stored as a string
 * where the empty string means "no override" (≡ null); the user flips it from the
 * bottom-ribbon toggle and it takes priority over the View-mode default until cleared.
 */
export type ChatUiOverride = 'chat' | 'terminal' | null;

declare global {
  interface Window {
    setChatUi: (val: ChatUiOverride | boolean) => void;
    getChatUi: () => ChatUiOverride;
  }
}

const LEGACY_BOOL_KEY = 'chatUiMode';

// One-time migration of the legacy boolean flag (true meant "force chat").
if (
  typeof localStorage !== 'undefined' &&
  instancePreferences.get(PrefKey.CHAT_UI_MODE) === '' &&
  localStorage.getItem(LEGACY_BOOL_KEY) === 'true'
) {
  instancePreferences.set(PrefKey.CHAT_UI_MODE, 'chat');
}
if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_BOOL_KEY);

function toOverride(v: unknown): ChatUiOverride {
  return v === 'chat' || v === 'terminal' ? v : null;
}

export function setChatUiOverride(val: ChatUiOverride): void {
  instancePreferences.set(PrefKey.CHAT_UI_MODE, val ?? '');
}

export function getChatUiOverride(): ChatUiOverride {
  return toOverride(instancePreferences.get(PrefKey.CHAT_UI_MODE));
}

// Console helper, back-compatible with the old boolean form:
//   setChatUi('chat' | 'terminal' | null) — explicit; setChatUi(true|false) — legacy.
defineGlobal('setChatUi', (val: ChatUiOverride | boolean) => {
  setChatUiOverride(val === true ? 'chat' : val === false ? null : val);
});
defineGlobal('getChatUi', getChatUiOverride);

export function useChatUiOverride(): ChatUiOverride {
  const [value] = usePreference<string>(PrefKey.CHAT_UI_MODE);
  return toOverride(value);
}

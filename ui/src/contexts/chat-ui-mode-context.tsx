import { instancePreferences, PrefKey } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { useCurrentDock } from '@src/navigation/useDockNavigation';
import { defineGlobal } from '@sdk/utils';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Chat mode — which surface an agent session is shown in. Three types:
 *  - `'vibe'`     → the vibe workspace (side chat + display). The default.
 *  - `'chat'`     → the chat pane.
 *  - `'terminal'` → the raw xterm.
 *
 * ONE preference (`preferences.ui.chat_ui_mode`, a boot key owned by prefMan, so
 * it syncs backend↔frontend) holds it. The mode switch writes it, so the default
 * for the next session is simply the user's last pick. Read it with
 * `getChatMode()`; when nothing is stored the default is `'vibe'`.
 *
 * Transport follows from the mode and has only two states: `'terminal'` is an
 * interactive PTY, `'chat'` and `'vibe'` are both headless print-mode. See
 * `chatModePtyMode`.
 *
 * NOTE `'vibe'` also exists in the unrelated ViewMode enum (the surface-complexity
 * ladder). They are different enums that happen to share a name — a known
 * confusion, to be cleaned up separately.
 *
 * The mode is also BROWSABLE: a dock URL can carry `?chatMode=` and
 * `useDockChatModeOverrideSync` pins it for the mounted route and adopts it into
 * the preference, so the switch never writes the pref from a click path.
 */
export type ChatMode = 'chat' | 'terminal' | 'vibe';

export const CHAT_MODE_DEFAULT: ChatMode = 'vibe';

declare global {
  interface Window {
    setChatUi: (val: ChatMode | boolean) => void;
    getChatUi: () => ChatMode;
  }
}

const LEGACY_BOOL_KEY = 'chatUiMode';

// One-time migration of the legacy boolean flag (true meant "force chat").
if (
  typeof localStorage !== 'undefined' &&
  !toChatMode(instancePreferences.get(PrefKey.CHAT_UI_MODE)) &&
  localStorage.getItem(LEGACY_BOOL_KEY) === 'true'
) {
  instancePreferences.set(PrefKey.CHAT_UI_MODE, 'chat');
}
if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_BOOL_KEY);

function toChatMode(v: unknown): ChatMode | null {
  return v === 'chat' || v === 'terminal' || v === 'vibe' ? v : null;
}

/** THE read: the stored chat mode, or the default when nothing is stored. */
export function getChatMode(): ChatMode {
  return toChatMode(instancePreferences.get(PrefKey.CHAT_UI_MODE)) ?? CHAT_MODE_DEFAULT;
}

export function setChatMode(val: ChatMode): void {
  instancePreferences.set(PrefKey.CHAT_UI_MODE, val);
}

/** Transport for a mode: only `terminal` runs an interactive PTY. */
export function chatModePtyMode(mode: ChatMode = getChatMode()): boolean {
  return mode === 'terminal';
}

defineGlobal('setChatUi', (val: ChatMode | boolean) => {
  setChatMode(val === true ? 'chat' : val === false ? 'terminal' : val);
});
defineGlobal('getChatUi', getChatMode);

// --- URL-carried override (mirrors the dock viewMode override) -------------
// The URL's chatMode is also adopted into the persisted preference on load, so
// this transient override normally equals the pref. It exists to pin the mode
// against externally-originated pref changes while a chatMode-carrying dock URL
// is mounted, and to drop back to the pref the moment that URL unmounts.
const chatModeOverrideListeners = new Set<() => void>();
let dockChatModeOverride: ChatMode | null = null;

function subscribeChatModeOverride(listener: () => void): () => void {
  chatModeOverrideListeners.add(listener);
  return () => chatModeOverrideListeners.delete(listener);
}

function getChatModeOverrideSnapshot(): ChatMode | null {
  return dockChatModeOverride;
}

function setDockChatModeOverride(val: ChatMode | null): void {
  if (dockChatModeOverride === val) return;
  dockChatModeOverride = val;
  chatModeOverrideListeners.forEach((listener) => listener());
}

/**
 * Sync the current DockPointer's `?chatMode` into `useChatMode()`.
 * Load-time owner of the arrangement: the switch only navigates; when that URL
 * loads here we pin the mode AND adopt it as the preference — so the default for
 * the next session is the user's last pick, with no write in the click path.
 */
export function useDockChatModeOverrideSync(): void {
  const currentDock = useCurrentDock();
  const override = currentDock?.chatMode ?? null;

  useEffect(() => {
    setDockChatModeOverride(override);
    // instancePreferences.set no-ops on equal values, so no guard is needed here.
    if (override) setChatMode(override);
  }, [override]);

  useEffect(() => () => setDockChatModeOverride(null), []);
}

/** Reactive read: the mounted URL's mode when it carries one, else the pref. */
export function useChatMode(): ChatMode {
  const [value] = usePreference<string>(PrefKey.CHAT_UI_MODE);
  const override = useSyncExternalStore(
    subscribeChatModeOverride,
    getChatModeOverrideSnapshot,
    getChatModeOverrideSnapshot,
  );
  return override ?? toChatMode(value) ?? CHAT_MODE_DEFAULT;
}

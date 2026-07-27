import { instancePreferences, PrefKey } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { previousNonVibeViewMode, ViewMode } from '@src/contexts/view-mode-context';
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

// Mirrors PREF_REGISTRY[CHAT_UI_MODE].defaultValue, which is the owner — this
// only catches a stored legacy value ('auto'/'') that is no longer in the domain.
const CHAT_MODE_DEFAULT: ChatMode = 'vibe';

declare global {
  interface Window {
    setChatUi: (val: ChatMode) => void;
    getChatUi: () => ChatMode;
  }
}

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
export function chatModePtyMode(mode: ChatMode): boolean {
  return mode === 'terminal';
}

/**
 * The URL options that put a dock into `mode` — the ONE place the ChatMode and
 * ViewMode enums touch. `vibe` is a chat mode AND a view mode (two separate
 * enums that share a name, to be unified later), so selecting it has to carry
 * both; leaving it has to restore the view mode in use before vibe.
 */
export function chatModeNavOptions(mode: ChatMode, leavingVibe = false): { chatMode: ChatMode; viewMode?: ViewMode } {
  if (mode === 'vibe') return { chatMode: mode, viewMode: ViewMode.Vibe };
  return { chatMode: mode, ...(leavingVibe ? { viewMode: previousNonVibeViewMode() } : {}) };
}

defineGlobal('setChatUi', setChatMode);
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

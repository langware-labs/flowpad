import { instancePreferences, PrefKey } from '@sdk';
import { usePreference } from '@src/hooks/use-preference';
import { getViewMode, isAdvancedMode, useIsAdvanced } from '@src/contexts/view-mode-context';
import { useCurrentDock } from '@src/navigation/useDockNavigation';
import { defineGlobal } from '@sdk/utils';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Which view an interactive agent tab shows.
 *  - `null`     → follow View mode (Standard ⇒ chat UI, Advanced ⇒ terminal).
 *  - `'chat'`   → force the chat UI regardless of View mode.
 *  - `'terminal'` → force the xterm terminal regardless of View mode.
 *
 * Owned by prefMan (`preferences.ui.chat_ui_mode`, a boot key). Stored as a string
 * where the empty string means "no override" (≡ null); the user flips it from the
 * terminal header's mode switch (`TerminalModeSwitch`) and it takes priority over the
 * View-mode default until cleared. NOTE it is instance-global, not per-session: a
 * per-session skin would need a PrefKey keyed by process id.
 *
 * The mode is also BROWSABLE: a dock URL can carry `?chatMode=chat|terminal`
 * (`DockPointer.withChatMode`), which `useDockChatModeOverrideSync` pins for the
 * mounted URL and adopts into the pref — exactly the `?viewMode` arrangement one
 * level up. So the switch never writes the pref from a click path: it navigates,
 * and the URL load is the single writer.
 */
export type ChatMode = 'chat' | 'terminal';
export type ChatUiOverride = ChatMode | null;

declare global {
  interface Window {
    setChatUi: (val: ChatUiOverride | boolean) => void;
    getChatUi: () => ChatUiOverride;
  }
}

const LEGACY_BOOL_KEY = 'chatUiMode';

/** Stored sentinel for "no override, follow View mode". The Preferences select
 *  cannot render an empty-string option, so the absent state is explicit; the
 *  historical '' is still read as auto. */
export const CHAT_MODE_AUTO = 'auto';

function isAuto(v: unknown): boolean {
  return v === CHAT_MODE_AUTO || v === '' || v == null;
}

// One-time migration of the legacy boolean flag (true meant "force chat").
if (
  typeof localStorage !== 'undefined' &&
  isAuto(instancePreferences.get(PrefKey.CHAT_UI_MODE)) &&
  localStorage.getItem(LEGACY_BOOL_KEY) === 'true'
) {
  instancePreferences.set(PrefKey.CHAT_UI_MODE, 'chat');
}
if (typeof localStorage !== 'undefined') localStorage.removeItem(LEGACY_BOOL_KEY);

function toOverride(v: unknown): ChatUiOverride {
  return v === 'chat' || v === 'terminal' ? v : null;
}

export function setChatUiOverride(val: ChatUiOverride): void {
  instancePreferences.set(PrefKey.CHAT_UI_MODE, val ?? CHAT_MODE_AUTO);
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

// --- URL-carried override (mirrors the dock viewMode override) -------------
// The URL's chatMode is also adopted into the persisted preference on load, so
// this transient override normally equals the pref. It exists to pin the mode
// against externally-originated pref changes while a chatMode-carrying dock URL
// is mounted, and to drop back to the pref the moment that URL unmounts.
const chatModeOverrideListeners = new Set<() => void>();
let dockChatModeOverride: ChatUiOverride = null;

function subscribeChatModeOverride(listener: () => void): () => void {
  chatModeOverrideListeners.add(listener);
  return () => chatModeOverrideListeners.delete(listener);
}

function getChatModeOverrideSnapshot(): ChatUiOverride {
  return dockChatModeOverride;
}

function setDockChatModeOverride(val: ChatUiOverride): void {
  if (dockChatModeOverride === val) return;
  dockChatModeOverride = val;
  chatModeOverrideListeners.forEach((listener) => listener());
}

/**
 * Sync the current DockPointer's `?chatMode` into `useChatUiOverride()`.
 * Load-time owner of the chat/terminal arrangement: the mode switch only
 * navigates (same pointer, `?chatMode=<mode>`); when that URL loads here we pin
 * the mode AND adopt it as the persisted preference, so the choice survives
 * leaving the URL and the session without any write in the click path.
 */
export function useDockChatModeOverrideSync(): void {
  const currentDock = useCurrentDock();
  const override = currentDock?.chatMode ?? null;

  useEffect(() => {
    setDockChatModeOverride(override);
    // instancePreferences.set no-ops on equal values, so no guard is needed here.
    if (override) setChatUiOverride(override);
  }, [override]);

  useEffect(() => () => setDockChatModeOverride(null), []);
}

/**
 * The ONE resolution rule for "which mode is this session in": the override when
 * set, otherwise the View-mode default (Standard ⇒ chat, Advanced/Dev ⇒
 * terminal). `InteractiveTerminal` renders by it and new sessions launch by it,
 * so what the user picks in the switch is what the next session opens as.
 */
export function resolveChatMode(override: ChatUiOverride, advanced: boolean): ChatMode {
  return override ?? (advanced ? 'terminal' : 'chat');
}

/** Reactive form — re-renders on either input changing. */
export function useEffectiveChatMode(): ChatMode {
  return resolveChatMode(useChatUiOverride(), useIsAdvanced());
}

/** Imperative form for non-React callers (the launch path). Reads the persisted
 *  view mode; a URL `?viewMode` is adopted into that pref on load, so the two
 *  agree everywhere a session is launched from. */
export function effectiveChatMode(): ChatMode {
  return resolveChatMode(getChatUiOverride(), isAdvancedMode(getViewMode()));
}

/**
 * `createProcess` arguments that launch a new session in the preferred mode.
 * Chat is the headless print-mode transport (no PTY, streams JSON); terminal is
 * an auto-started interactive PTY. Spread `context` into the first argument and
 * `options` into the second.
 */
export function chatModeLaunchArgs(): {
  context: { outputFormat?: 'stream-json' };
  options: { visible: boolean; pty_mode: boolean };
} {
  return effectiveChatMode() === 'chat'
    ? { context: { outputFormat: 'stream-json' }, options: { visible: false, pty_mode: false } }
    : { context: {}, options: { visible: true, pty_mode: true } };
}

export function useChatUiOverride(): ChatUiOverride {
  const [value] = usePreference<string>(PrefKey.CHAT_UI_MODE);
  const override = useSyncExternalStore(
    subscribeChatModeOverride,
    getChatModeOverrideSnapshot,
    getChatModeOverrideSnapshot,
  );
  return override ?? toOverride(value);
}

import { useEffect, useState } from 'react';
import { defineGlobal } from '@sdk/utils';

declare global {
  interface Window {
    setChatUi: (val: boolean) => void;
    getChatUi: () => boolean;
  }
}

const CHAT_UI_MODE_KEY = 'chatUiMode';

// Chat-UI mode is a *debug* toggle persisted in localStorage, mirroring the
// dev-mode flag. It controls whether an AgenticProcess surface renders the
// experimental SimpleChatPane ("ui") instead of the xterm terminal.
//
// Default is FALSE → the terminal is the default for every process, everywhere.
// The simple chat view is not stable enough for users to work with, so it is
// reachable ONLY through the ProcessToolbar debug dropdown (which only renders
// in the Advanced tab header), never a public toggle. Flip with
// window.setChatUi() or the "Chat UI (experimental)" item in that dropdown.
let _chatUiMode: boolean = localStorage.getItem(CHAT_UI_MODE_KEY) === 'true';
const _listeners = new Set<(val: boolean) => void>();

export function setChatUiMode(val: boolean): void {
  _chatUiMode = val;
  localStorage.setItem(CHAT_UI_MODE_KEY, String(val));
  _listeners.forEach((fn) => fn(val));
}

function getChatUiMode(): boolean {
  return _chatUiMode;
}

defineGlobal('setChatUi', setChatUiMode);
defineGlobal('getChatUi', getChatUiMode);

export function useChatUiMode(): boolean {
  const [chatUiMode, setChatUiModeState] = useState(_chatUiMode);

  useEffect(() => {
    _listeners.add(setChatUiModeState);
    return () => {
      _listeners.delete(setChatUiModeState);
    };
  }, []);

  return chatUiMode;
}

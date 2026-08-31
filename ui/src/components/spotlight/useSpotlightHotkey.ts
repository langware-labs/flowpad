import { useEffect } from 'react';
import { toggleSpotlight } from '@src/store/use-spotlight-store';

/** True when the keyboard event originated inside a text input / contenteditable.
 *  We skip the Spotlight hotkey there so Cmd/Ctrl+K stays available for editor
 *  commands (Milkdown "insert link", Monaco shortcuts, native form actions). */
function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

/** Registers Cmd/Ctrl+K → toggle Spotlight, except when an editable element has focus. */
export function useSpotlightHotkey(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (isTextInputTarget(e.target)) return;
      e.preventDefault();
      toggleSpotlight();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}

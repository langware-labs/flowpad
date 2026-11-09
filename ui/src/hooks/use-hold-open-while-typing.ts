import { useCallback, useRef } from 'react';

/**
 * A hover card closes when the pointer leaves it. One that holds a text field
 * must not while that field has focus, or what was being typed is lost. A click
 * outside and Escape still close it.
 *
 * Spread `contentProps` on the card's content, and ignore a close request while
 * `holdsOpen()` is true.
 */
export function useHoldOpenWhileTyping() {
  const contentRef = useRef<HTMLDivElement>(null);
  const dismissed = useRef(false);
  const dismiss = useCallback(() => {
    dismissed.current = true;
  }, []);
  const holdsOpen = useCallback(() => {
    const wasDismissed = dismissed.current;
    dismissed.current = false;
    const focused = document.activeElement;
    return !wasDismissed && focused instanceof HTMLInputElement && !!contentRef.current?.contains(focused);
  }, []);
  return {
    holdsOpen,
    contentProps: { ref: contentRef, onPointerDownOutside: dismiss, onEscapeKeyDown: dismiss },
  };
}

import { useCallback, useRef, type MouseEvent } from 'react';

const stopPropagation = (event: MouseEvent) => event.stopPropagation();

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
    contentProps: {
      ref: contentRef,
      onPointerDownOutside: dismiss,
      onEscapeKeyDown: dismiss,
      // The card is portaled, but its clicks still bubble to whatever holds its trigger. A click
      // on the field is the card's own: the address bar must not read it as a click on its dead
      // space and take the focus for its ask input.
      onClick: stopPropagation,
    },
  };
}

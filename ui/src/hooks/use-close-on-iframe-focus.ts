import { useCallback, useEffect, useState } from 'react';

/**
 * Close an open overlay when focus moves into an iframe (a web app tab's
 * page). A press inside an iframe never reaches this document, so Radix's
 * outside-press dismissal can't see it — the only signal is the window
 * blurring with the iframe as the active element. Switching to another app
 * also blurs the window but leaves the overlay alone.
 */
export function useCloseOnIframeFocus(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onWindowBlur = () => {
      if (document.activeElement instanceof HTMLIFrameElement) close();
    };
    window.addEventListener('blur', onWindowBlur);
    return () => window.removeEventListener('blur', onWindowBlur);
  }, [open, close]);
}

/**
 * Open state for an overlay root that also closes on a press inside an iframe.
 * Honours a caller's controlled `open`/`onOpenChange`; owns the state otherwise.
 */
export function useIframeDismissibleOpen({
  open: controlled,
  defaultOpen = false,
  onOpenChange,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(defaultOpen);
  const open = controlled ?? own;
  const setOpen = useCallback(
    (next: boolean) => {
      setOwn(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = useCallback(() => setOpen(false), [setOpen]);
  useCloseOnIframeFocus(open, close);
  return { open, onOpenChange: setOpen };
}

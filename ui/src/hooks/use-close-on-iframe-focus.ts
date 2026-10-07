import { useEffect } from 'react';

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

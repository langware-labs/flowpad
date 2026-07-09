import { useEffect, useRef } from 'react';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/**
 * Close a transient container (slider/dialog) when a navigation happens while
 * it's open. Watches `currentDock` and fires `onClose` on the first dock change
 * after open — a single guard that covers BOTH the pointer arm (openDock) and
 * the imperative `activate` arm (session-like favorites), which don't share a
 * single callback. Skips the render on which it opened so opening doesn't
 * self-close. Editing (drag/rename/folder) never navigates, so it never closes
 * the container.
 */
export function useCloseOnNavigate(open: boolean, onClose: () => void): void {
  const { currentDock } = useDockNavigation();
  const openedAtRef = useRef<string | null>(null);
  // Read `onClose` through a ref so callers needn't memoize it to avoid churn.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) {
      openedAtRef.current = null;
      return;
    }
    const key = currentDock?.toString() ?? null;
    if (openedAtRef.current === null) {
      openedAtRef.current = key;
      return;
    }
    if (key !== openedAtRef.current) onCloseRef.current();
  }, [open, currentDock]);
}

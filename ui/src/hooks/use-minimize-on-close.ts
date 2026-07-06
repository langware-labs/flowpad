import { animateMinimizeToElement } from '@src/lib/minimize-to-element';
import { useCallback, useRef } from 'react';

/**
 * Genie-minimize a closing overlay into the element that owns it (typically
 * its trigger button), so the user's eye lands on where to reopen it.
 *
 * Attach `sourceRef` to the overlay content (dialog/popover content) and
 * `targetRef` to the landing element, then pass `handleOpenChange` as the
 * Radix `onOpenChange`. Interactive dismissals (outside click, Escape,
 * trigger toggle) animate; programmatic `setOpen(false)` calls skip Radix's
 * `onOpenChange` and therefore close without the flight — which is what a
 * "replace this surface with another" flow wants.
 *
 * Overlays with conditional or dynamically-located targets (e.g. the diagnose
 * modal flying into the process chip only while a run is live) call
 * `animateMinimizeToElement` / `animateMinimizeToProcessChip` directly.
 */
export function useMinimizeOnClose(setOpen: (open: boolean) => void) {
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<HTMLButtonElement | null>(null);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) animateMinimizeToElement(sourceRef.current, targetRef.current);
      setOpen(open);
    },
    [setOpen],
  );

  return { sourceRef, targetRef, handleOpenChange };
}

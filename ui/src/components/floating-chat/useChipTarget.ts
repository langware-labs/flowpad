import { openDisplayTarget } from '@src/navigation/open-display-target';
import { useDockNavigation } from '@src/navigation';
import { useCallback } from 'react';
import type { ChipTarget } from './toolEventDescriptor';

/**
 * Turn a chip's {@link ChipTarget} into a click handler, or null when the chip
 * has nothing to open (the row stays a plain payload expander).
 *
 * A chip target IS a display target, so routing is `openDisplayTarget` — the
 * one place that maps "the backend said show this" onto a nav call. Re-deriving
 * the editor/pointer lookup here would fork that mapping (and miss the special
 * cases it already carries, e.g. agentic processes and web apps).
 */
export function useChipTarget(target: ChipTarget): (() => void) | null {
  const { navigation } = useDockNavigation();
  const open = useCallback(() => openDisplayTarget(target, navigation), [navigation, target]);
  return target ? open : null;
}

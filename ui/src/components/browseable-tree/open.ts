import type { DockPointer } from '@src/navigation/DockPointer';
import type { Browseable } from './types';

/**
 * The open contract for Browseable containers — the executable form of the
 * `pointer ?? activate` invariant that `types.ts` describes, shared by every
 * renderer (tree rows, desktop-grid tiles) so an open means the same thing on
 * each. Sibling of `drag.ts`, for the same reason: a protocol both renderers
 * must speak identically belongs in one place, not copy-pasted per surface.
 *
 * `pointer` is the preferred pure arm (click == navigate to the pointer);
 * `activate` is the documented imperative fallback. `onOpen` fires only when
 * one of them actually dispatched, and always AFTER it, so a throwing usage
 * stamp can never break the navigation.
 *
 * Containers are NOT handled here: a click on one expands rather than opens,
 * and the two renderers expand differently (popover vs chevron). Each keeps
 * its own container branch and calls this for the non-container case.
 *
 * Returns whether anything opened, so a caller can fall back (e.g. the tree
 * expands a pointer-less parent).
 */
export function openBrowseable(node: Browseable, navigate: (pointer: DockPointer) => void): boolean {
  if (node.pointer) navigate(node.pointer);
  else if (node.activate) void node.activate();
  else return false;
  node.onOpen?.();
  return true;
}

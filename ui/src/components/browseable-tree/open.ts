import type { DockPointer } from '@src/navigation/DockPointer';
import { assetTargetLookup, type AssetRow } from '@src/navigation/record-type-nav';
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
  else if (node.activate) void node.activate(navigate);
  else return false;
  node.onOpen?.();
  return true;
}

/**
 * How an asset row opens: through its type's lookup when the target needs one (a dataset
 * opens in its editor app), else at `pointer`. One answer for every asset tree, and the same
 * one the Assets page and the record list give.
 */
export function assetRowOpen(asset: AssetRow, pointer: DockPointer): Pick<Browseable, 'pointer' | 'activate'> {
  const lookup = assetTargetLookup(asset);
  if (!lookup) return { pointer };
  return {
    pointer: null,
    activate: async (navigate) => {
      const target = await lookup();
      if (target) navigate(target);
    },
  };
}

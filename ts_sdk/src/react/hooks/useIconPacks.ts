import { useSyncExternalStore } from 'react';
import { getIconPacks, onIconPacksChanged } from '../../icons/registry';
import type { IconPackSpec } from '../../icons/types';

/**
 * The loaded packs, as a render-time value that CHANGES when they load.
 *
 * `loadIconPacks` replaces the array, so its identity is the version — the
 * same identity `resolve.ts` keys its index on. Anything that resolves an icon
 * inside a memo must take the array from here and list it as a dependency; a
 * subscription that only bumps a counter re-renders the component and then
 * hands back the memoized `none`, which is how every icon mounted before the
 * bootstrap landed stayed blank until its subtree remounted.
 */
export function useIconPacks(): IconPackSpec[] {
  return useSyncExternalStore(onIconPacksChanged, getIconPacks, getIconPacks);
}

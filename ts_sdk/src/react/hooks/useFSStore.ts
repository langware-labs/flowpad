import { useStore } from 'zustand';
import { fsStore, type FSStoreState } from '@sdk';

/**
 * React hook wrapper for the vanilla fsStore from the SDK.
 * This allows React components to subscribe to store changes.
 *
 * @example
 * ```tsx
 * const browseCache = useFSStore((state) => state.browseCache);
 * const contentCache = useFSStore((state) => state.contentCache);
 * ```
 */
export function useFSStore<T>(selector: (state: FSStoreState) => T): T {
  return useStore(fsStore, selector);
}

/**
 * For non-React usage or direct .getState() calls,
 * re-export the vanilla store.
 */
export { fsStore };

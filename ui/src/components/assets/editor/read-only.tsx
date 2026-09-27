import { createContext, useContext } from 'react';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

/**
 * Forces every asset viewer below it read-only. A host that shows a copy the user
 * must not edit — the review of a received, not-yet-installed asset — sets it; a
 * dock tab says the same through its URL (`?readOnly=1`).
 */
const AssetReadOnlyContext = createContext(false);

export const AssetReadOnlyProvider = AssetReadOnlyContext.Provider;

/** The one read-only question every asset viewer asks: forced by the host, or by the URL. */
export function useAssetReadOnly(): boolean {
  const forced = useContext(AssetReadOnlyContext);
  const { currentDock } = useDockNavigation();
  return forced || currentDock?.options?.readOnly === '1';
}

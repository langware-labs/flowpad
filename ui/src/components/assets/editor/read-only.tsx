import { createContext, useContext } from 'react';
import { useCurrentDock } from '@src/navigation/useDockNavigation';

/**
 * A read-only occurrence the host is showing: a copy the user must not edit —
 * the review of a received, not-yet-installed asset. `assetType` names the copy's
 * type so viewers need not ask the backend to classify a path that has no record.
 * A dock tab says the same through its URL (`?readOnly=1&assetType=…`).
 */
interface ReadOnlyOccurrence {
  assetType?: string;
}

const AssetReadOnlyContext = createContext<ReadOnlyOccurrence | null>(null);

export const AssetReadOnlyProvider = AssetReadOnlyContext.Provider;

/** The one read-only question every asset viewer asks: forced by the host, or by the URL. */
export function useAssetReadOnly(): boolean {
  const forced = useContext(AssetReadOnlyContext);
  const dock = useCurrentDock();
  return forced != null || dock?.options?.readOnly === '1';
}

/** True when a host (not the URL) is showing a read-only occurrence: a path with no
 *  record behind it, which viewers must not ask the backend to classify or index. */
export function useHostReadOnlyOccurrence(): boolean {
  return useContext(AssetReadOnlyContext) != null;
}

/** The read-only occurrence's declared type, from the host or the URL. */
export function useReadOnlyOccurrenceType(): string | undefined {
  const forced = useContext(AssetReadOnlyContext);
  const dock = useCurrentDock();
  return forced?.assetType ?? dock?.options?.assetType;
}

import { createContext, useContext } from 'react';

/**
 * The editor a view is nested in (see `DockPointer.child`), when it is. An editor that would
 * otherwise navigate away on its own — back to an asset list after a delete — asks the host to
 * close it instead, so the person lands back on the parent (the agent) rather than elsewhere.
 * Absent (null) for an editor shown on its own, which keeps its standalone behaviour.
 */
export interface NestedHost {
  /** Close the nested view: back to the parent's own body. */
  close: () => void;
}

export const NestedHostContext = createContext<NestedHost | null>(null);

export function useNestedHost(): NestedHost | null {
  return useContext(NestedHostContext);
}

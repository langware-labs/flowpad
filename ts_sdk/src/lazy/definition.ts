export interface LoadContext {
  /** Owned by the SDK scope; unmounting a component never aborts a shared read. */
  signal: AbortSignal;
  isCurrent: () => boolean;
}

export interface AssetDefinition<P, T> {
  load: (params: P, context: LoadContext) => Promise<T>;
  key?: (params: P) => unknown;
  staleTime?: number;
  /** Subscribe to the canonical entity/live store, retaining its entity references. */
  subscribe?: (params: P, publish: (value: T) => void, initial: T) => Promise<() => void> | (() => void);
}

export function defineAsset<P, T>(definition: AssetDefinition<P, T>): AssetDefinition<P, T> {
  return definition;
}

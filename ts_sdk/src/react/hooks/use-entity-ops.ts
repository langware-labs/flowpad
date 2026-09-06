import { useEffect } from 'react';
import { subscribeToEntityOps, type EntityOpListener, type SubscribeToEntityOpsOptions } from '../../FlowSync/entity-ops';
export * from '../../FlowSync/entity-ops';

/**
 * React hook wrapper around {@link subscribeToEntityOps}. Subscribes on
 * mount, unsubscribes on unmount via the effect's cleanup. Re-subscribes if
 * `types`, `listener`, or `options` identity changes — memoize the listener
 * (e.g. via `useCallback`) if you don't want re-subscribes on every render.
 *
 * For module-scoped subscriptions (lifetime = application) use
 * {@link subscribeToEntityOps} directly.
 */
export function useEntityOps(
  types: string | readonly string[],
  listener: EntityOpListener,
  options?: SubscribeToEntityOpsOptions,
): void {
  useEffect(() => {
    return subscribeToEntityOps(types, listener, options);
  }, [types, listener, options]);
}

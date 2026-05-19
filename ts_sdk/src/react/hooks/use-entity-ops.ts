import { useEffect } from 'react';
import { ConnectionManager, IEntity, TypeId } from '@sdk';

export type EntityOp = 'create' | 'update' | 'delete';
export type EntityOpListener = (typeId: TypeId, op: EntityOp, data: IEntity) => void;

export interface SubscribeToEntityOpsOptions {
  /** Restrict to a subset of ops. Defaults to all three. */
  ops?: readonly EntityOp[];
}

/**
 * Imperative subscription to entity create / update / delete events that
 * arrive over the WebSocket. Returns an unsubscribe function.
 *
 * Filters by entity type and op O(1) before invoking the listener — consumers
 * do not re-implement type-match boilerplate. The listener fires AFTER the
 * SDK has updated its entity cache and watched-query results, so reads from
 * `Entity.getByIdFromCache(...)` inside the callback are safe.
 *
 * The listener is attached to the singleton `ConnectionManager`, so it
 * survives WS reconnects (the connection re-emits `on_data_op` after
 * recovery; the listener does not need to re-attach).
 *
 * Use this when the subscription's lifetime is the application (module-scoped
 * stores, top-level data hooks). For component-scoped subscriptions, prefer
 * the {@link useEntityOps} React hook which handles `useEffect` cleanup.
 */
export function subscribeToEntityOps(
  types: string | readonly string[],
  listener: EntityOpListener,
  options?: SubscribeToEntityOpsOptions,
): () => void {
  const typeSet = new Set(Array.isArray(types) ? types : [types as string]);
  const opSet = options?.ops ? new Set(options.ops) : null;

  const wrapped = (typeIdStr: string, op: EntityOp, data: IEntity): void => {
    if (opSet && !opSet.has(op)) return;
    let typeId: TypeId;
    try {
      typeId = new TypeId(typeIdStr);
    } catch {
      return;
    }
    if (!typeSet.has(typeId.type)) return;
    listener(typeId, op, data);
  };

  const cm = ConnectionManager.getInstance();
  cm.on('on_data_op', wrapped);
  return () => {
    cm.off('on_data_op', wrapped);
  };
}

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

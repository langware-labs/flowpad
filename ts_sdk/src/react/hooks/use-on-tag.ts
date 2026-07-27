import { useEffect, useRef } from 'react';
import { EventBus, TagFilters, FlowEventHandler } from '../../tags/EventBus';

/**
 * Subscribe to the unified event bus for exactly the lifetime of the caller —
 * the returned unsubscriber IS the effect cleanup, so unmount (or a
 * pattern/target change) always unhooks before anything else happens. The
 * handler rides a ref: the latest closure fires without resubscribing every
 * render.
 */
export function useOnTag(pattern: string, handler: FlowEventHandler, filters?: TagFilters): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const target = filters?.target;
  // Scope re-keys on VALUE (joined), not array identity — callers pass fresh
  // literals every render and must not churn the subscription.
  const scopeKey = filters?.scope?.join('\u0000');
  useEffect(
    () =>
      EventBus.on(pattern, (event) => handlerRef.current(event), {
        ...(target !== undefined ? { target } : {}),
        ...(scopeKey !== undefined ? { scope: scopeKey.split('\u0000') } : {}),
      }),
    [pattern, target, scopeKey],
  );
}

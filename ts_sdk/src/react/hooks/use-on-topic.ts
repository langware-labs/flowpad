import { useEffect, useRef } from 'react';
import { EventBus, TopicFilters, TopicHandler } from '../../topics/EventBus';

/**
 * Subscribe to the unified event bus for exactly the lifetime of the caller —
 * the returned unsubscriber IS the effect cleanup, so unmount (or a
 * pattern/target change) always unhooks before anything else happens. The
 * handler rides a ref: the latest closure fires without resubscribing every
 * render.
 */
export function useOnTopic(pattern: string, handler: TopicHandler, filters?: TopicFilters): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const target = filters?.target;
  useEffect(() => EventBus.on(pattern, (event) => handlerRef.current(event), target !== undefined ? { target } : undefined), [pattern, target]);
}

/**
 * Shared keyed-event dispatch — "one subscription, many keyed readers".
 *
 * The SDK emitters (`ConnectionManager`, `cloudManager`) broadcast a single
 * stream of events for the whole app. A conversation renders one bubble per
 * message, and each bubble wants the slice of that stream addressed to *its*
 * message id. The naive approach — every bubble calling `emitter.on(...)` and
 * filtering — attaches N raw listeners to a singleton (tripping
 * `MaxListenersExceededWarning` past 10) and runs all N filters on every event
 * (O(N) per frame, scaling with conversation length).
 *
 * Instead: attach exactly ONE listener to the emitter and route each event to
 * the handlers registered under its extracted key via a `Map`. Listener count
 * on the emitter stays at 1 regardless of message count; dispatch is O(1) per
 * event. The shared subscription is created lazily on the first registration
 * and torn down when the last reader unregisters, so an idle route holds no
 * emitter listener.
 */
export type KeyedDispatch<Args extends unknown[]> = (
  key: string,
  cb: (...args: Args) => void,
) => () => void;

export function createKeyedDispatch<Args extends unknown[]>(
  /** Attach the single underlying listener; return its teardown. */
  subscribe: (handler: (...args: Args) => void) => () => void,
  /** Extract the routing key from an event's args; null = drop. */
  keyOf: (...args: Args) => string | null | undefined,
): KeyedDispatch<Args> {
  const readers = new Map<string, Set<(...args: Args) => void>>();
  let unsubscribe: (() => void) | null = null;

  const onEvent = (...args: Args) => {
    const key = keyOf(...args);
    if (!key) return;
    const set = readers.get(key);
    if (!set) return;
    // Snapshot so a handler that unregisters mid-dispatch can't mutate the
    // live set we're iterating.
    for (const cb of [...set]) cb(...args);
  };

  return (key, cb) => {
    let set = readers.get(key);
    if (!set) {
      set = new Set();
      readers.set(key, set);
    }
    set.add(cb);
    if (!unsubscribe) unsubscribe = subscribe(onEvent);

    return () => {
      const s = readers.get(key);
      if (s) {
        s.delete(cb);
        if (s.size === 0) readers.delete(key);
      }
      if (readers.size === 0 && unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };
  };
}

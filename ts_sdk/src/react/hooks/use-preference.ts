import { instancePreferences, InstancePreferencesEvent, PrefKey } from '@sdk';
import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Read and write a single preference by its dotted tag key.
 *
 * Returns a `[value, setValue]` tuple (useState-like). The value is the stored
 * "data" coerced to its registered dataType; `setValue` schedules a debounced
 * save and re-renders subscribers via the InstancePreferences version counter.
 *
 * @example
 * const [showSystemSkills, setShowSystemSkills] =
 *   usePreference<boolean>(PrefKey.SHOW_SYSTEM_SKILLS);
 */

// Single EE subscription shared across all callers, so the singleton's listener
// count stays at 2 regardless of how many PrefControls (or other consumers)
// mount — avoids Node's MaxListenersExceededWarning.
const subscribers = new Set<() => void>();
let eeAttached = false;

const notify = () => {
  for (const cb of subscribers) cb();
};

const subscribe = (callback: () => void) => {
  if (!eeAttached) {
    instancePreferences.on(InstancePreferencesEvent.PREFERENCES_CHANGED, notify);
    instancePreferences.on(InstancePreferencesEvent.PREFERENCES_LOADED, notify);
    eeAttached = true;
  }
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
};

const getSnapshot = () => instancePreferences.version;

export function usePreference<T = unknown>(tag: PrefKey): [T, (value: T) => void] {
  useEffect(() => {
    if (!instancePreferences.isLoaded) {
      void instancePreferences.loadJson();
    }
  }, []);

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setValue = useCallback(
    (value: T) => {
      instancePreferences.set(tag, value);
    },
    [tag],
  );

  return [instancePreferences.get(tag) as T, setValue];
}

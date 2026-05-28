import { instancePreferences, InstancePreferencesEvent } from '@sdk';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Hook to access and subscribe to per-instance UI preferences.
 *
 * The returned `preferences` object is the InstancePreferences singleton.
 * Mutating a field (e.g., `preferences.showSystemSkills = true`) triggers
 * a debounced auto-save and re-renders subscribed components.
 *
 * @example
 * const { preferences } = useInstancePreferences();
 * preferences.showSystemSkills = !preferences.showSystemSkills;
 */

// Single EE subscription shared across all callers, so the singleton's listener
// count stays at 2 regardless of how many components mount.
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

export function useInstancePreferences() {
  useEffect(() => {
    if (!instancePreferences.isLoaded) {
      void instancePreferences.loadJson();
    }
  }, []);

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { preferences: instancePreferences };
}

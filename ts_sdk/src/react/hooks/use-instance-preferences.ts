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
export function useInstancePreferences() {
  useEffect(() => {
    if (!instancePreferences.isLoaded) {
      void instancePreferences.loadJson();
    }
  }, []);

  const subscribe = (callback: () => void) => {
    instancePreferences.on(InstancePreferencesEvent.PREFERENCES_CHANGED, callback);
    instancePreferences.on(InstancePreferencesEvent.PREFERENCES_LOADED, callback);

    return () => {
      instancePreferences.off(InstancePreferencesEvent.PREFERENCES_CHANGED, callback);
      instancePreferences.off(InstancePreferencesEvent.PREFERENCES_LOADED, callback);
    };
  };

  const getSnapshot = () => instancePreferences.version;

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { preferences: instancePreferences };
}

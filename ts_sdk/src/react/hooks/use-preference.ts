import { PrefKey } from '../../preferences/prefRegistry';
import { InstancePreferencesEvent, instancePreferences } from '../../services/InstancePreferences';
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

/**
 * Whether `tag`'s value is known yet — see `InstancePreferences.isResolved`.
 *
 * Use it wherever falling back to the registry default would paint a user-visible
 * arrangement that the stored value then contradicts: hold the decision while
 * this is false instead of rendering a guess and repainting. Re-renders on
 * PREFERENCES_LOADED, so the wait ends the moment the value lands.
 */
export function usePreferenceResolved(tag: PrefKey): boolean {
  usePreferencesVersion();
  return instancePreferences.isResolved(tag);
}

/**
 * Subscribe to *any* preference change, without binding to one key.
 *
 * The load-on-mount + subscribe primitive both other hooks in this file are built
 * on, and the one consumers use directly when they read several prefs imperatively
 * — the Preferences screen's `visibleWhen` filter, whose hook count must not depend
 * on how many rows it is about to render.
 */
export function usePreferencesVersion(): number {
  useEffect(() => {
    if (!instancePreferences.isLoaded) {
      void instancePreferences.loadJson();
    }
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * One preference's value, re-rendering ONLY when that value changes.
 *
 * `usePreference` binds to the store's version counter, so every consumer re-renders on
 * ANY preference change — the view mode is saved on every Standard ⇄ Advanced flip, which
 * re-rendered (and re-parsed) every `MarkdownView` in a long chat, 600 of them: 2.5-4.5 s
 * per flip (FLOWPAD-2193). A component that only READS a value and is rendered many times
 * over should use this instead.
 *
 * PRIMITIVES ONLY (string / number / boolean): the snapshot is compared with `Object.is`,
 * so a value that is a fresh object on every read would never settle.
 */
export function usePreferenceValue<T extends string | number | boolean | null | undefined>(tag: PrefKey): T {
  useEffect(() => {
    if (!instancePreferences.isLoaded) {
      void instancePreferences.loadJson();
    }
  }, []);
  const getSnapshot = () => instancePreferences.get(tag) as T;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePreference<T = unknown>(tag: PrefKey): [T, (value: T) => void] {
  usePreferencesVersion();

  const setValue = useCallback(
    (value: T) => {
      instancePreferences.set(tag, value);
    },
    [tag],
  );

  return [instancePreferences.get(tag) as T, setValue];
}

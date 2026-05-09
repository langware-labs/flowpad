import { workspaceSetting, WorkspaceSettingEvent } from '@sdk';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Hook to access and subscribe to workspace settings.
 *
 * The returned `settings` object is the WorkspaceSetting singleton.
 * Changes to settings (e.g., `settings.showSystemSkills = true`) trigger
 * debounced auto-save and re-render of subscribed components.
 *
 * @example
 * const { settings } = useSettings();
 * // Toggle system skills visibility
 * settings.showSystemSkills = !settings.showSystemSkills;
 */

// Single EE subscription shared across all useSettings() callers, so the
// singleton's listener count stays at 2 regardless of how many components mount.
const subscribers = new Set<() => void>();
let eeAttached = false;

const notify = () => {
  for (const cb of subscribers) cb();
};

const subscribe = (callback: () => void) => {
  if (!eeAttached) {
    workspaceSetting.on(WorkspaceSettingEvent.SETTINGS_CHANGED, notify);
    workspaceSetting.on(WorkspaceSettingEvent.SETTINGS_LOADED, notify);
    eeAttached = true;
  }
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
};

const getSnapshot = () => workspaceSetting.version;

export function useSettings() {
  // Load settings on first use
  useEffect(() => {
    if (!workspaceSetting.isLoaded) {
      void workspaceSetting.loadJson();
    }
  }, []);

  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { settings: workspaceSetting };
}

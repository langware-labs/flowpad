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
export function useSettings() {
  // Load settings on first use
  useEffect(() => {
    if (!workspaceSetting.isLoaded) {
      void workspaceSetting.loadJson();
    }
  }, []);

  // Subscribe to external store using useSyncExternalStore
  const subscribe = (callback: () => void) => {
    workspaceSetting.on(WorkspaceSettingEvent.SETTINGS_CHANGED, callback);
    workspaceSetting.on(WorkspaceSettingEvent.SETTINGS_LOADED, callback);

    return () => {
      workspaceSetting.off(WorkspaceSettingEvent.SETTINGS_CHANGED, callback);
      workspaceSetting.off(WorkspaceSettingEvent.SETTINGS_LOADED, callback);
    };
  };

  // Get snapshot returns a version counter to trigger re-renders on change
  // Using a primitive avoids infinite loops from object reference changes
  const getSnapshot = () => workspaceSetting.version;

  // Subscribe to changes
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { settings: workspaceSetting };
}

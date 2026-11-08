import { useEffect, useState } from 'react';
import { usePreferencesVersion } from '@src/hooks/use-preference';
import { browserProfileManager, fetchBrowserProfiles, type Browser, type ProfileChoice } from '@sdk/services/browser-profiles';

export * from '@sdk/services/browser-profiles';

/** `fetchBrowserProfiles` while `enabled`; the last list stays meanwhile. */
export function useBrowserProfiles(enabled = true): Browser[] {
  const [browsers, setBrowsers] = useState<Browser[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetchBrowserProfiles().then((list) => live && setBrowsers(list));
    return () => {
      live = false;
    };
  }, [enabled]);
  return browsers;
}

export function useSelectedBrowserProfile(): ProfileChoice | null {
  usePreferencesVersion();
  return browserProfileManager.selected;
}

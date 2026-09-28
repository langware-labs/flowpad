import { dataContext, RuntimeKind } from '@sdk';
import apiClient from '@sdk/client';

/** One profile of an installed browser; `id` is what an open names (see `flow_sdk/core/browser_profiles.py`). */
export interface BrowserProfile {
  id: string;
  name: string;
  email: string | null;
}

export interface Browser {
  id: string;
  name: string;
  profiles: BrowserProfile[];
}

/** Only a backend on the user's own machine can see — and launch — their browsers. */
function backendIsOnThisMachine(): boolean {
  const kind = dataContext.runtimeKind;
  return kind === RuntimeKind.DESKTOP || kind === RuntimeKind.BROWSER;
}

/**
 * The installed browsers and their profiles, asked fresh each time — a profile added a minute ago shows on
 * the next right-click. `[]` off the user's machine (without asking) or when the backend cannot list them.
 */
export async function fetchBrowserProfiles(): Promise<Browser[]> {
  if (!backendIsOnThisMachine()) return [];
  try {
    return (await apiClient.get<{ browsers: Browser[] }>('/api/v1/browser-profiles')).browsers;
  } catch (error) {
    console.warn('[browser-profiles] could not list browser profiles', error);
    return [];
  }
}

/** Open a web URL in one browser profile. Rejects with the backend's reason. */
export async function openInBrowserProfile(url: string, browser: string, profile: string): Promise<void> {
  await apiClient.post('/api/v1/browser-profiles/open', { browser, profile, url });
}

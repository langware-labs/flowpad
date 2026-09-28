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

let loaded: Promise<Browser[]> | null = null;

/** Only a backend on the user's own machine can see — and launch — their browsers. */
function backendIsOnThisMachine(): boolean {
  const kind = dataContext.runtimeKind;
  return kind === RuntimeKind.DESKTOP || kind === RuntimeKind.BROWSER;
}

/**
 * The installed browsers and their profiles, fetched once per session. A failed fetch is
 * forgotten so the next caller retries; off the user's machine it is `[]` without asking.
 */
export function loadBrowserProfiles(): Promise<Browser[]> {
  if (!backendIsOnThisMachine()) return Promise.resolve([]);
  loaded ??= apiClient.get<{ browsers: Browser[] }>('/api/v1/browser-profiles').then(
    (res) => res.browsers,
    (error: unknown) => {
      loaded = null;
      console.warn('[browser-profiles] could not list browser profiles', error);
      return [];
    },
  );
  return loaded;
}

/** Open a web URL in one browser profile. Rejects with the backend's reason. */
export async function openInBrowserProfile(url: string, browser: string, profile: string): Promise<void> {
  await apiClient.post('/api/v1/browser-profiles/open', { browser, profile, url });
}

/** For tests: forget the session's list. */
export function resetBrowserProfiles(): void {
  loaded = null;
}

import apiClient from '../client';
import { dataContext } from '../FlowSync/context';
import { RuntimeKind } from '../utils/runtime';
import { instancePreferences } from './InstancePreferences';
import { PrefKey } from '../preferences/prefRegistry';

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

/** One shared setting for links, command pages, and sign-in; null delegates to the OS.
 * Keep the existing key so previously saved choices continue to work.
 */
export type ProfileChoice = { browser: string; profile: string };
export const browserProfileManager = {
  list: fetchBrowserProfiles,
  open: openInBrowserProfile,
  get selected(): ProfileChoice | null {
    if (!backendIsOnThisMachine()) return null;
    const value = instancePreferences.get(PrefKey.COMMAND_LINK_BROWSER) as Partial<ProfileChoice> | null;
    return value && typeof value.browser === 'string' && typeof value.profile === 'string'
      ? { browser: value.browser, profile: value.profile }
      : null;
  },
  select(choice: ProfileChoice | null): void {
    instancePreferences.set(PrefKey.COMMAND_LINK_BROWSER, choice);
  },
  profile(browsers: Browser[], choice: ProfileChoice | null): BrowserProfile | undefined {
    return browsers.find((browser) => browser.id === choice?.browser)?.profiles.find((profile) => profile.id === choice?.profile);
  },
  async command(command: string, choice: ProfileChoice | null, target: 'session' | 'terminal'): Promise<string> {
    if (!choice) return command;
    return (await apiClient.post<{ command: string }>('/api/v1/browser-profiles/command', {
      ...choice, command, target,
    })).command;
  },
};


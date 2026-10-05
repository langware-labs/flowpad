/**
 * The magic line, with the sign-in question in front of it.
 *
 * Smart navigation needs the hub's decision API, and the hub only lists it to a signed-in box.
 * Signed out, `askOrOpen` quietly asks the assistant every time — correct, but the person never
 * learns that signing in would let "open data sources" just open it. So, signed out, the first
 * request of a session asks: Log in, or continue without. Either way the request then runs as
 * normal — the held text is never dropped, and a cancelled or failed sign-in is the plain ask.
 *
 * "Don't ask again" is the preference `SMART_NAVIGATION_SIGNIN` = `skip`: a setting under
 * Notifications the person can flip back, not a hidden flag.
 *
 * Signed in, nothing here awaits: one synchronous check, then `askOrOpen` exactly as before.
 */

import { t } from '@lingui/core/macro';
import { cloudManager, instancePreferences, isHubOnly, PrefKey, privacyManager } from '@sdk';

import { askNotification } from '@src/notifications';
import { askOrOpen } from '@src/navigation/navigation-decision';
import type { DockPointer } from '@src/navigation/DockPointer';

type Handlers = { open: (dock: DockPointer) => void; ask: (prompt: string) => void };

export const SMART_NAVIGATION_SIGNIN_ASK_ID = 'smart-navigation-signin';

/** Asked once per page session: after any answer, the rest of the session is not asked again. */
let askedThisSession = false;

export function __resetSmartAskForTests(): void {
  askedThisSession = false;
}

export async function smartAskOrOpen(text: string, handlers: Handlers): Promise<'opened' | 'asked'> {
  // Fast path first, and synchronous: signed in, or a box where signing in is not on offer
  // (Local privacy mode forbids it; a hub-only page has no `@local` navigator at all).
  if (cloudManager.isLoggedIn || privacyManager.isLocal || isHubOnly() || askedThisSession) {
    return askOrOpen(text, handlers);
  }
  if (!instancePreferences.isLoaded) await instancePreferences.loadJson();
  if (instancePreferences.get(PrefKey.SMART_NAVIGATION_SIGNIN) !== 'ask') return askOrOpen(text, handlers);

  askedThisSession = true;
  const { value, remember } = await askNotification({
    id: SMART_NAVIGATION_SIGNIN_ASK_ID,
    title: t`Smart navigation requires sign-in`,
    message: t`Sign in and requests like "open data sources" open the screen directly.`,
    choices: [
      { value: 'login', label: t`Log in` },
      { value: 'continue', label: t`Continue without smart navigation` },
    ],
    remember: { label: t`Don't ask again` },
    // The request waits on this answer, so it is asked where it cannot be missed.
    location: 'center',
  });
  if (remember) instancePreferences.set(PrefKey.SMART_NAVIGATION_SIGNIN, 'skip');
  if (value === 'login') {
    try {
      await cloudManager.login();
    } catch {
      // Cancelled, superseded or failed: the request still runs, as a plain ask.
    }
  }
  return askOrOpen(text, handlers);
}

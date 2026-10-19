import { navigator as sdkNavigator } from '@sdk';

/**
 * An entry page's answer to a 401: one round trip through sign-in, never two.
 *
 * The first 401 for `key` remembers the attempt and sends the browser to login
 * with a callback to this page. A 401 on the way back means the user IS signed
 * in, as someone the hub won't let see this — bouncing again would loop — so it
 * answers `'exhausted'` and the page shows the wrong-account panel instead.
 * `sessionStorage`, so the attempt dies with the tab.
 */
export function bounceToLoginOnce(key: string): 'redirecting' | 'exhausted' {
  if (sessionStorage.getItem(key)) return 'exhausted';
  sessionStorage.setItem(key, '1');
  window.location.assign(sdkNavigator.getLoginWithCallbackUrl(window.location.href));
  return 'redirecting';
}

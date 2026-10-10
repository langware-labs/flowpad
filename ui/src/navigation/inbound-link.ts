/**
 * Reading a URL that came from OUTSIDE the app.
 *
 * Deliberately not `DockPointer`. An invite token, an OAuth callback, a
 * `flowpad://` protocol handoff, an install or launch deep link — these arrive
 * before there is any location to speak of, and their params are a one-time
 * payload rather than addressable app state. That is the one legitimate reason
 * to read a URL as a URL, and it is why the navigation rule ("compose on the
 * pointer") does not reach here.
 *
 * What these landings DID share, and shouldn't, is the ritual: read some params,
 * then scrub them off the URL so a refresh does not re-fire the action. That was
 * hand-written per landing, and a landing that forgets the scrub silently
 * re-triggers on every reload.
 */

/**
 * The `?action=` values a deep link carries — "someone sent you here to do X". A load carrying
 * one belongs to its handler (`IncomingDeepLink`): no ambient redirect may run first.
 */
export const DeepLinkAction = { OPEN: 'open', LAUNCH: 'launch' } as const;

export function isDeepLinkAction(action: string | null): boolean {
  return Object.values(DeepLinkAction).includes(action as (typeof DeepLinkAction)[keyof typeof DeepLinkAction]);
}

/** The params of the inbound URL, read but not consumed. */
export function inboundParams(url: string = window.location.href): URLSearchParams {
  return new URL(url, window.location.origin).searchParams;
}

/**
 * Read `keys` off the inbound URL and REMOVE them from the address bar, so a
 * refresh cannot replay whatever they triggered.
 *
 * Returns the values read (before the scrub). Removal is a `replaceState`, so it
 * adds no history entry — the user's back button still goes where they came
 * from, not to the link they just consumed.
 */
export function consumeInboundParams(keys: readonly string[]): Record<string, string | null> {
  const url = new URL(window.location.href);
  const taken: Record<string, string | null> = {};
  let found = false;
  for (const key of keys) {
    taken[key] = url.searchParams.get(key);
    if (taken[key] !== null) found = true;
    url.searchParams.delete(key);
  }
  // Only rewrite when something was actually there — an unconditional
  // replaceState on every mount is a needless history write.
  if (found) window.history.replaceState(null, '', url.toString());
  return taken;
}

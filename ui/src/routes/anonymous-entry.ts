/**
 * The hub routes a signed-OUT visitor may render.
 *
 * Everywhere else, a session-less load in hub mode is bounced straight to the
 * provider login (`cloudManager.seedBootstrap`) — the hub app is account-scoped
 * and a signed-out shell would have nothing in it. An entry route arrived at
 * from OUTSIDE the app is the exception: the whole point of `/launch?repo=…` is
 * that a stranger opens it, and it cannot ask anyone to approve a repository it
 * was not allowed to render.
 *
 * Being on this list buys exactly one thing — the page renders — and costs the
 * page a duty: it must drive its own sign-in, from a click. That is not a style
 * preference. `window.open` is refused without transient activation, so a click
 * is the only place a popup can be opened, and the popup is the only way the
 * user keeps the tab (and therefore the query string that IS the payload of a
 * launch link).
 *
 * Deliberately a prefix-free exact match on the pathname: `/launch` is one page,
 * and a `startsWith` would quietly hand anonymous rendering to anything nested
 * under it later.
 */
const ANONYMOUS_ENTRY_PATHS: ReadonlySet<string> = new Set(['/launch']);

/** Whether `pathname` is an entry route that renders without a session. */
export function isAnonymousEntryPath(pathname: string): boolean {
  // Trailing slashes come from hand-typed and pasted links, which is precisely
  // how these routes are reached.
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return ANONYMOUS_ENTRY_PATHS.has(normalized);
}

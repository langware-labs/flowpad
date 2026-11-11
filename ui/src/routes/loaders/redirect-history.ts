import type { DataStrategyFunction, DataStrategyResult } from 'react-router';

/**
 * I7 (docs/navigation/dock-loading.md): a loader redirect takes the place of the
 * URL being loaded, and only that URL. Decided here, once per load, for every
 * loader — loaders just `redirect()`.
 *
 * React Router writes history only after the loaders finish, and it fixes a
 * redirect's push/replace from the redirect alone (`X-Remix-Replace`), never
 * from the navigation that caused it. So:
 *
 * - The address bar already shows the URL being loaded (cold load, reload,
 *   Back/Forward): the redirect REPLACES it, or it would stay behind as a Back
 *   step that bounces forward.
 * - It does not (an in-app navigation): the redirect must not replace, or it
 *   overwrites the page the user came from. The navigation then writes the
 *   target itself — a push, or a replace if it was one.
 */
export const redirectHistoryStrategy: DataStrategyFunction = async ({ request, matches }) => {
  const toLoad = matches.filter((m) => m.shouldLoad);
  const results = await Promise.all(toLoad.map((m) => m.resolve()));
  const committed = isInHistory(request.url);
  const keyed: Record<string, DataStrategyResult> = {};
  toLoad.forEach((m, i) => {
    keyed[m.route.id] = settleRedirect(results[i], committed);
  });
  return keyed;
};

/** True when the address bar shows `url` (path + search; a request never carries a hash). */
function isInHistory(url: string): boolean {
  const u = new URL(url);
  return u.pathname + u.search === window.location.pathname + window.location.search;
}

function settleRedirect(result: DataStrategyResult, replace: boolean): DataStrategyResult {
  const response = result.result;
  if (response instanceof Response && response.status >= 300 && response.status < 400) {
    if (replace) response.headers.set('X-Remix-Replace', 'true');
    else response.headers.delete('X-Remix-Replace');
  }
  return result;
}

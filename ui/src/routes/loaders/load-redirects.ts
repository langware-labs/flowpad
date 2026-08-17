/**
 * Load-time redirect resolvers — the generic seam for "redirect into X on
 * page load" features (journeys' auto-launch is the first). The loader stays
 * feature-agnostic: features register a resolver from their own module; the
 * home loader just runs the list before render.
 *
 * A resolver returns a `redirect(...)` Response to take over the load, or
 * null to pass. Resolvers must never throw the load away — fail to null.
 */
export type LoadRedirectResolver = (request: Request) => Promise<Response | null>;

const resolvers: LoadRedirectResolver[] = [];

export function registerLoadRedirect(fn: LoadRedirectResolver): void {
  if (!resolvers.includes(fn)) resolvers.push(fn);
}

/** First redirect wins; null when no feature wants this load. */
export async function runLoadRedirects(request: Request): Promise<Response | null> {
  for (const fn of resolvers) {
    try {
      const r = await fn(request);
      if (r) return r;
    } catch (e) {
      console.debug('[load-redirects] resolver skipped', e);
    }
  }
  return null;
}

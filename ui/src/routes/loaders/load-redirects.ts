/**
 * Load-time redirect resolvers — the generic seam for "redirect into X on
 * page load" features (journeys' auto-launch is the first). The loader stays
 * feature-agnostic: features register a resolver from their own module; the
 * home loader just runs the list before render.
 *
 * A resolver returns a `redirect(...)` Response to take over the load, or
 * null to pass. Resolvers must never throw the load away — fail to null.
 */
import { PageId } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

export type LoadRedirectResolver = (request: Request) => Promise<Response | null>;

/**
 * The project an AMBIENT redirect may act on for this load, or `undefined`
 * when no ambient redirect is allowed here at all. Shared by every resolver so
 * "which desktop project is this load about" is decided once:
 *
 *  - `?action=open` is a deep link the user was SENT here by; it outranks an
 *    ambient redirect, which would rewrite the query before anything read it
 *    (a launched sandbox once came up with no project that way).
 *  - Hub Project routes reuse the pointer grammar, but the Hub runs nothing.
 *  - A shell route is already inside a session.
 *
 * `null` means "allowed, but no project in the URL" — `/` and non-dock routes,
 * where the caller decides on a fallback (the adopted default project, or an
 * unscoped query).
 */
export function ambientLoadProjectId(request: Request): string | null | undefined {
  const url = new URL(request.url);
  if (url.searchParams.get('action') === 'open') return undefined;
  try {
    const dock = DockPointer.fromUrl(url.toString());
    if (dock.page === PageId.HUB || dock.viewType === ViewType.SHELL) return undefined;
    if (dock.viewType === ViewType.PROJECT) {
      return DockPointer.parseProjectPointer(dock.pointer).projectTypeId?.id ?? null;
    }
  } catch {
    // Not a dock URL: fall through to the caller's fallback.
  }
  return null;
}

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

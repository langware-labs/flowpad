import { PageId, isValidPage } from '@sdk';
import { DockPointer } from './DockPointer';

/**
 * Server-declared supported pages → navigation policy.
 *
 * The backend reports which SPA-surfaces ("pages") it serves on bootstrap
 * (`BootstrapInfo.supported_pages`; the local desktop server sends `["desk"]`).
 * A dock URL naming a page this server does not serve is redirected to the first
 * supported page's home. These helpers are pure — the loader passes the raw
 * bootstrap list in, so they carry no `dataContext` dependency and stay unit-
 * testable.
 */

/**
 * Coerce the raw bootstrap list into a clean `PageId[]`: drop anything that
 * isn't a known page id, and fall back to `[desk]` when the list is missing,
 * empty, or entirely unknown — so navigation always has a safe home to land on.
 */
export function normalizeSupportedPages(list: string[] | undefined | null): PageId[] {
  const known = (list ?? []).filter(isValidPage);
  return known.length > 0 ? known : [PageId.DESK];
}

/**
 * If `dock` addresses a page this server does not serve, return the URL of the
 * first supported page's home (to redirect to); otherwise return null.
 *
 *   supported ["desk"] + a `hub` dock → "/dock/home"
 *   supported ["hub"]  + a `desk` dock → "/dock/hub/home"
 *   supported includes dock.page       → null (no redirect)
 */
export function pageRedirectUrl(
  dock: DockPointer,
  rawSupported: string[] | undefined | null,
  currentPath: string = '',
): string | null {
  const supported = normalizeSupportedPages(rawSupported);
  if (supported.includes(dock.page)) return null;
  return DockPointer.forHome().withPage(supported[0]).toUrl(currentPath);
}

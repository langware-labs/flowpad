import { PageId, isValidPage } from '@sdk';
import { DockPointer } from './DockPointer';

/**
 * Server-declared supported pages → navigation policy.
 *
 * The backend reports which SPA-surfaces ("pages") it serves on bootstrap
 * (`BootstrapInfo.supported_pages`; the local desktop server sends `["desk","hub"]`,
 * the hub `["hub"]`). A pointer naming a page this server does not serve is moved
 * to the page it does serve — at the click (`openDock`) and, for a typed or old
 * link, by the loader. These helpers are pure — the caller passes the raw
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
 * `dock` on a page this server serves: itself when its page is served, else the
 * same view on the first supported page. Every `DockPointer.forX()` defaults to
 * `desk`, so on a hub-only server this is what keeps a click on the hub without
 * each caller remembering `.withPage(PageId.HUB)`.
 */
export function onServedPage(dock: DockPointer, rawSupported: string[] | undefined | null): DockPointer {
  const supported = normalizeSupportedPages(rawSupported);
  return supported.includes(dock.page) ? dock : dock.withPage(supported[0]);
}

/**
 * If `dock` addresses a page this server does not serve, return the URL of the
 * same view on the page it does serve (to redirect to); otherwise return null.
 *
 *   supported ["hub"]  + `/dock/conversation/<id>` → "/dock/hub/conversation/<id>"
 *   supported includes dock.page                   → null (no redirect)
 */
export function pageRedirectUrl(
  dock: DockPointer,
  rawSupported: string[] | undefined | null,
  currentPath: string = '',
): string | null {
  const served = onServedPage(dock, rawSupported);
  return served === dock ? null : served.toUrl(currentPath);
}

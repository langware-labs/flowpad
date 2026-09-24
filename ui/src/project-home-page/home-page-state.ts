import type { DockPointer } from '@src/navigation/DockPointer';

/**
 * The URL option that asks for the project home page. Set by the navigations
 * that mean "take me into this project" — launching a project, and the Home
 * button (`NavigationActions.goHome({ homePage: true })`) — through
 * `withHomePage`. Any navigation without it (a cold start, the project's own
 * page, a tab) does not redirect. A URL option (not a flag in memory) so the
 * request is real location state; not sticky, so it never rides onto the next
 * navigation.
 */
export const HOME_PAGE_PARAM = 'homePage';
export const HOME_PAGE_OPEN = 'open';

/** `dock`, asking to land on its project's home page (see `HOME_PAGE_PARAM`). */
export function withHomePage(dock: DockPointer): DockPointer {
  return dock.withOption(HOME_PAGE_PARAM, HOME_PAGE_OPEN);
}

const STORAGE_PREFIX = 'flowpad.projectHomePage.';

/**
 * Remember where `projectId`'s home page resolved to, so Home can tell "I am on
 * it" from "I am elsewhere". Per browser tab (sessionStorage), not in memory: a
 * reload of the home page's own URL makes no redirect, and a forgotten dock
 * would leave Home redirecting straight back to where the user already is.
 */
export function rememberProjectHomePage(projectId: string, dock: DockPointer): void {
  const hash = dock.tabHash;
  if (!hash) return;
  try {
    sessionStorage.setItem(STORAGE_PREFIX + projectId, hash);
  } catch {
    // Storage unavailable: Home still works, it just cannot toggle to the default home.
  }
}

/** Whether `dock` is the home page `projectId` last resolved to in this tab. */
export function isProjectHomePage(projectId: string | null | undefined, dock: DockPointer): boolean {
  if (!projectId || !dock.tabHash) return false;
  try {
    return sessionStorage.getItem(STORAGE_PREFIX + projectId) === dock.tabHash;
  } catch {
    return false;
  }
}

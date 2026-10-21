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

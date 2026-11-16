import { useContext, type ContextType } from 'react';
import { UNSAFE_DataRouterContext, type NavigateFunction, type NavigateOptions, type To } from 'react-router';
import { DockPointer } from './DockPointer';
import { NavigationActions } from './NavigationActions';
import { ROOT_PATH } from './url-builder';
import { useDockNavigation } from './useDockNavigation';

/** The dock a URL shows — `useCurrentDock`'s rule, for a caller holding the URL and its params. */
function dockOfUrl(pathname: string, search: string, viewType: string | undefined): DockPointer | null {
  const url = `${pathname}${search}`;
  if (viewType) {
    try {
      return DockPointer.fromUrl(url);
    } catch {
      return new DockPointer();
    }
  }
  if (pathname === ROOT_PATH) return DockPointer.root().withOptionsFromUrl(url);
  return null;
}

type DataRouter = NonNullable<ContextType<typeof UNSAFE_DataRouterContext>>['router'];

const routerActions = new WeakMap<DataRouter, NavigationActions>();

/** ONE NavigationActions per data router, reading the router's committed state when it acts. */
function actionsForRouter(router: DataRouter): NavigationActions {
  let actions = routerActions.get(router);
  if (actions) return actions;
  const navigate = ((to: To | number, options?: NavigateOptions) =>
    typeof to === 'number' ? router.navigate(to) : router.navigate(to, options)) as NavigateFunction;
  actions = new NavigationActions(navigate, () => {
    const { location, matches } = router.state;
    const viewType = matches[matches.length - 1]?.params.viewType;
    return dockOfUrl(location.pathname, location.search, viewType);
  });
  // The per-render instances settle a pending navigation as the URL commits; this
  // one is never rebuilt, so it settles from the router itself.
  router.subscribe(() => NavigationActions.clearCommittedPendingNavigation());
  routerActions.set(router, actions);
  return actions;
}

/**
 * The navigation actions alone, for a component that navigates but does not show
 * where the app is. Unlike `useDockNavigation().navigation` it never re-renders the
 * caller on a URL change: the instance is the router's own and reads the
 * committed dock when it acts. `useNavigate()` itself would subscribe (it reads the
 * route context, rebuilt on every navigation), so the data router is used directly.
 *
 * A tab switch re-rendered every navigate-only component on screen — most of the
 * chrome — through `useDockNavigation` (docs/navigation/dock-loading.md).
 */
export function useNavigationActions(): NavigationActions {
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  // Outside a data router (a unit test's <MemoryRouter>): the location-bound actions.
  // Which router hosts a mounted tree never changes, so the hook order is stable.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (!router) return useDockNavigation().navigation;
  return actionsForRouter(router);
}

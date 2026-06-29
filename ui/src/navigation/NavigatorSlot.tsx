import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { NAVIGATOR_REGISTRY } from './navigatorRegistry';

/**
 * NavigatorSlot — Zone B. Reads the active view from the URL (currentDock) and
 * renders that view's registered navigator, or nothing (body goes full-width).
 * The component-per-view registry keeps hooks unconditional: switching views
 * unmounts the old navigator and mounts the new one.
 */
export function NavigatorSlot() {
  const { currentDock, isDockUrl } = useDockNavigation();
  const viewType = isDockUrl && currentDock?.viewType ? currentDock.viewType : ViewType.HOME;
  const Navigator = NAVIGATOR_REGISTRY[viewType];
  return Navigator ? <Navigator /> : null;
}

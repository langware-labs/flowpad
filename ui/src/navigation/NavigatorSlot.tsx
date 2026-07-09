import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { DockPointer } from './DockPointer';
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
  // A collaboration room owns its own left panel (Shared Sessions) — it is not
  // an asset browser, so suppress the project AssetsNavigator when a room is
  // active in the URL.
  if (viewType === ViewType.PROJECT && DockPointer.parseProjectPointer(currentDock?.pointer).roomId) {
    return null;
  }
  const Navigator = NAVIGATOR_REGISTRY[viewType];
  return Navigator ? <Navigator /> : null;
}

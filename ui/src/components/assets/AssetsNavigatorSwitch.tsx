import { AgentResourcesNavigator } from '@src/components/agent-resources/AgentResourcesNavigator';
import { AssetEditor } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AssetsNavigator } from './AssetsNavigator';

/**
 * Zone B for asset views: the tree, except while an agent is being edited. A
 * switch component, not a branch inside `AssetsNavigator` — its top-level
 * `useAssetsModel()` would become conditional. Pure URL read, no lookup.
 */
export function AssetsNavigatorSwitch() {
  const { currentDock } = useDockNavigation();
  return currentDock?.assetEditor === AssetEditor.AGENT ? <AgentResourcesNavigator /> : <AssetsNavigator />;
}

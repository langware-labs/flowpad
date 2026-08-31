import { AgentResourcesNavigator } from '@src/components/agent-resources/AgentResourcesNavigator';
import { AssetEditor } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { AssetsNavigator } from './AssetsNavigator';

/**
 * Zone B for the asset-shaped views: the assets tree, except while an agent is
 * open for editing, where the agent-resources pane takes over.
 *
 * A switch component rather than a branch inside `AssetsNavigator` because the
 * registry's contract is component-per-view specifically to keep hooks
 * unconditional — `AssetsNavigator` calls `useAssetsModel()` at its top, so a
 * branch there would make that call conditional. Mounting one whole component
 * or the other keeps each side's hooks unconditional within it.
 *
 * The discrimination is a pure URL read: the `<editor>` segment is present for
 * both routing methods, so this resolves synchronously on first render with no
 * entity lookup — and `AssetEditor.AGENT` covers exactly the `agent` type, so a
 * SubAgent editor (a different editor) keeps the assets tree.
 */
export function AssetsNavigatorSwitch() {
  const { currentDock } = useDockNavigation();
  return currentDock?.assetEditor === AssetEditor.AGENT ? <AgentResourcesNavigator /> : <AssetsNavigator />;
}

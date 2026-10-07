import type { ComponentType } from 'react';
import { ViewType } from '@src/types/ViewType';
import { DocsNavigator } from '@src/components/docs-viewer/DocsNavigator';
import { AssetsNavigatorSwitch } from '@src/components/assets/AssetsNavigatorSwitch';
import { AutomationsNavigator } from '@src/components/automations/AutomationsNavigator';
import { ChatsNavigator } from '@src/components/chats-navigator/ChatsNavigator';
import { ExplorerNavigator } from '@src/components/explorer-view/ExplorerNavigator';
import { GraphWorkflowsNavigator } from '@src/components/graph-workflows/GraphWorkflowsNavigator';

/**
 * Navigator registry — maps a ViewType to the component that fills the shared
 * left-menu slot (Zone B) for that view. Each value is a self-contained
 * component that calls its own hooks, builds a NavigatorDescriptor, and renders
 * <NavigatorPanel/>. Component-per-view (not a descriptor factory) keeps hooks
 * unconditional: NavigatorSlot mounts exactly one of these at a time, so each
 * navigator's hooks run only while its view is active.
 *
 * A view absent from this map renders no left menu (body goes full-width).
 */
export const NAVIGATOR_REGISTRY: Partial<Record<ViewType, ComponentType>> = {
  [ViewType.DOCS]: DocsNavigator,
  // The switch, not the tree directly: an agent editor rides these same two
  // view types and swaps in its own resource pane (AssetsNavigatorSwitch).
  [ViewType.ASSETS]: AssetsNavigatorSwitch,
  [ViewType.PROJECT]: AssetsNavigatorSwitch,
  [ViewType.AUTOMATIONS]: AutomationsNavigator,
  [ViewType.SHELL]: ChatsNavigator,
  [ViewType.VIBE]: ChatsNavigator,
  [ViewType.EXPLORER]: ExplorerNavigator,
  [ViewType.GRAPH_WORKFLOWS]: GraphWorkflowsNavigator,
};

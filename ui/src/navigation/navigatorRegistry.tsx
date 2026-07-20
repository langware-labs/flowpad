import type { ComponentType } from 'react';
import { ViewType } from '@src/types/ViewType';
import { DocsNavigator } from '@src/components/docs-viewer/DocsNavigator';
import { AssetsNavigator } from '@src/components/assets/AssetsNavigator';
import { TriggersNavigator } from '@src/components/triggers-view/TriggersNavigator';
import { ChatsNavigator } from '@src/components/chats-navigator/ChatsNavigator';
import { ExplorerNavigator } from '@src/components/explorer-view/ExplorerNavigator';
import { AgenticFlowsNavigator } from '@src/components/agentic-flows/AgenticFlowsNavigator';

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
  [ViewType.ASSETS]: AssetsNavigator,
  [ViewType.PROJECT]: AssetsNavigator,
  [ViewType.TRIGGERS]: TriggersNavigator,
  [ViewType.CRON]: TriggersNavigator,
  [ViewType.SHELL]: ChatsNavigator,
  [ViewType.EXPLORER]: ExplorerNavigator,
  [ViewType.AGENTIC_FLOWS]: AgenticFlowsNavigator,
};

import { ViewType, WorldViewProjection } from '@sdk';
import { Building2, Globe, Home, KeyRound } from 'lucide-react';
import type React from 'react';

import { iconForType } from '@src/components/graph-view/icons/iconRegistry';

import type { HubRailItemId } from './rail-visibility';

/** Any icon the rail can render — lucide components and our own alike. */
export type RailIcon = React.ComponentType<{ className?: string }>;

/** One HUB rail entry. Always a real dock target, and `pointer` distinguishes
 *  same-viewType destinations (WorldView world vs organization, records/<type>). */
export type HubItem = {
  id: HubRailItemId;
  title: string;
  icon: RailIcon;
  viewType: ViewType;
  pointer?: string;
};

/**
 * The hub-page rail, in render order.
 *
 * A plain builder rather than an array inline in the sidebar, so membership and
 * order are testable without rendering the sidebar — which drags in a dozen
 * providers. Mirrors what `rail-visibility.ts` already does for the desk rail;
 * note the two id unions stay separate on purpose, so a hub id can't be written
 * into `RAIL_ITEMS` where it would render a silent `null`.
 *
 * `t` is passed in so the caller's `useLingui` owns re-translation on locale change.
 *
 * The record-browser entries take their glyph from the backend type registry via
 * `iconForType(pointer)` — their pointer IS the entity type, and the view each
 * one opens resolves its icon the same way, so a hardcoded glyph here could
 * disagree with the destination it leads to. The remaining four are views, not
 * entity types, and have no registry entry to read.
 */
export function buildHubRailItems(t: (s: TemplateStringsArray) => string): readonly HubItem[] {
  return [
    { id: 'home', title: t`Home`, icon: Home, viewType: ViewType.HOME },
    {
      id: 'conversations',
      title: t`Conversations`,
      icon: iconForType('conversation'),
      viewType: ViewType.HUB_RECORDS,
      pointer: 'conversation',
    },
    { id: 'tasks', title: t`Tasks`, icon: iconForType('task'), viewType: ViewType.HUB_RECORDS, pointer: 'task' },
    { id: 'docs', title: t`Docs`, icon: iconForType('markdown'), viewType: ViewType.HUB_RECORDS, pointer: 'markdown' },
    {
      id: 'flows',
      title: t`Flows`,
      icon: iconForType('graph_workflow'),
      viewType: ViewType.HUB_RECORDS,
      pointer: 'graph_workflow',
    },
    {
      id: 'world',
      title: t`Your world`,
      icon: Globe,
      viewType: ViewType.WORLDVIEW,
      pointer: WorldViewProjection.WORLD,
    },
    {
      id: 'organization',
      title: t`Organization`,
      icon: Building2,
      viewType: ViewType.WORLDVIEW,
      pointer: WorldViewProjection.ORGANIZATION,
    },
    // Last: the seven above are content browsers and stay contiguous; this is a
    // settings-flavoured destination.
    //
    // Deliberately POINTER-LESS. `hubActive` matches pointer-carrying items on
    // viewType AND pointer, so a pointer here would unlight the icon the moment
    // the user switched tab or project.
    { id: 'credentials', title: t`Credentials`, icon: KeyRound, viewType: ViewType.CREDENTIALS },
  ];
}

import { t } from '@lingui/core/macro';
import { ViewType } from '@sdk';
import { Building2, Gauge, KeyRound, Mail } from 'lucide-react';
import type React from 'react';

import type { HubRailItemId } from './rail-visibility';

/** Any icon the rail can render — lucide components and our own alike. */
export type RailIcon = React.ComponentType<{ className?: string }>;

/** One HUB rail entry. Always a real dock target, and `pointer` distinguishes
 *  same-viewType destinations (e.g. records/<type>). */
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
 * into `RAIL_ITEMS`.
 *
 * `t` is passed in so the caller's `useLingui` owns re-translation on locale change.
 *
 * Glyphs are lucide icons: every entry is a PLACE rather than a type. Stream Inbox
 * opens a `conversation` list but keeps the desk slot's `Mail` (see `navMeta` in
 * `collapsed-sidebar.tsx`) rather than the type's glyph.
 */
export function buildHubRailItems(t: (s: TemplateStringsArray) => string): readonly HubItem[] {
  return [
    // `home` and `project` are deliberately ABSENT here, as on the desk rail:
    // both moved to the top navigation bar, which renders on the hub too (its
    // Home button keeps hub navigation under `page=hub`, and the project is the
    // leading breadcrumb). Two buttons for one destination is the thing the
    // rail has always avoided.
    // Stream Inbox, matching the desk's Stream Inbox slot (same `Mail` glyph). It lists the
    // hub's `conversation` entities over `graph/conversation`; the desk
    // `StreamInboxView` is NOT reusable here, because everything it reads is desk-only
    // (`conversation-list` action → 404 on the hub, `stream_inbox_manager` → 422), so it
    // would render an empty shell. That also means no unread badge on the hub.
    {
      id: 'stream_inbox',
      title: t`Stream Inbox`,
      icon: Mail,
      viewType: ViewType.HUB_RECORDS,
      pointer: 'conversation',
    },
    // Tasks and Docs are hidden for now (ids stay in HubRailItemId to bring them back).
    {
      // The plain people-and-teams screen. The org WORLDVIEW shows the same data
      // as a graph and is reachable from inside it — the graph is the advanced
      // view, not the front door.
      id: 'organization',
      title: t`Organization`,
      icon: Building2,
      viewType: ViewType.ORGANIZATION,
    },
    // Last: everything above is a place to look at content and stays contiguous;
    // this is a settings-flavoured destination.
    //
    // Deliberately POINTER-LESS. `hubActive` matches pointer-carrying items on
    // viewType AND pointer, so a pointer here would unlight the icon the moment
    // the user switched tab or project.
    // Pointer-less for the same reason: the pointer is the selected scope
    // (me / team / org), and the icon must stay lit while the user switches.
    { id: 'token-plan', title: t`Token plan`, icon: Gauge, viewType: ViewType.TOKEN_PLAN },
    // Pointer-less for the same reason: the pointer is the selected endpoint +
    // tab, and the icon must stay lit while the user drills into one.
    { id: 'credentials', title: t`Credentials`, icon: KeyRound, viewType: ViewType.CREDENTIALS },
  ];
}

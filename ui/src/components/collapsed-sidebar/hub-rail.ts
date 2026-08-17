import { t } from '@lingui/core/macro';
import { ViewType, WorldViewProjection } from '@sdk';
import { Building2, Globe, KeyRound, Mail, Waypoints } from 'lucide-react';
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
 * Glyphs come from the backend type registry via `iconForType(pointer)` wherever
 * the entry IS a type — the view it opens resolves its rows the same way, so a
 * hardcoded glyph would disagree with the destination it leads to. Entries that
 * name a lucide icon directly are the ones that are a PLACE rather than a type
 * (WorldView, Credentials) — and Inbox, deliberately: it happens to open a
 * `conversation` list, but the slot is the desk's Inbox, so it keeps that slot's
 * `Mail` (see `navMeta` in `collapsed-sidebar.tsx`) rather than the type's glyph.
 */
export function buildHubRailItems(t: (s: TemplateStringsArray) => string): readonly HubItem[] {
  return [
    // `home` and `project` are deliberately ABSENT here, as on the desk rail:
    // both moved to the top navigation bar, which renders on the hub too (its
    // Home button keeps hub navigation under `page=hub`, and the project is the
    // leading breadcrumb). Two buttons for one destination is the thing the
    // rail has always avoided.
    // Inbox, matching the desk's Inbox slot (same `Mail` glyph). It lists the
    // hub's `conversation` entities over `graph/conversation`; the desk
    // `InboxView` is NOT reusable here, because everything it reads is desk-only
    // (`conversation-list` action → 404 on the hub, `inbox_manager` → 422), so it
    // would render an empty shell. That also means no unread badge on the hub.
    {
      id: 'inbox',
      title: t`Inbox`,
      icon: Mail,
      viewType: ViewType.HUB_RECORDS,
      pointer: 'conversation',
    },
    { id: 'tasks', title: t`Tasks`, icon: iconForType('task'), viewType: ViewType.HUB_RECORDS, pointer: 'task' },
    { id: 'docs', title: t`Docs`, icon: iconForType('markdown'), viewType: ViewType.HUB_RECORDS, pointer: 'markdown' },
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
    // Last: everything above is a place to look at content and stays contiguous;
    // this is a settings-flavoured destination.
    //
    // Deliberately POINTER-LESS. `hubActive` matches pointer-carrying items on
    // viewType AND pointer, so a pointer here would unlight the icon the moment
    // the user switched tab or project.
    // Pointer-less for the same reason: the pointer is the selected endpoint +
    // tab, and the icon must stay lit while the user drills into one.
    { id: 'llm-endpoints', title: t`LLM Endpoints`, icon: Waypoints, viewType: ViewType.LLM_ENDPOINTS },
    { id: 'credentials', title: t`Credentials`, icon: KeyRound, viewType: ViewType.CREDENTIALS },
  ];
}

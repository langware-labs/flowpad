import { ThemeToggle } from '@src/components/theme-toggle/theme-toggle';
import { FlowpadAssistantButton } from '@src/components/floating-chat';
import { useIsDev } from '@src/components/view-mode';
import { buildHubRailItems, type HubItem, type RailIcon } from './hub-rail';
import { OrgTeamsButton } from './OrgTeamsButton';
import { RAIL_ITEMS, type RailItemId } from './rail-visibility';
import { Button } from '@src/components/ui/button';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { useStreamInboxManager } from '@src/hooks/useStreamInboxManager';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@src/components/ui/sidebar';
import { PageId } from '@sdk';
import { TAB_LINE_HEIGHT_CLASS } from '@src/components/tabs/TabStrip';
import { JourneyBadge } from '@src/journey/JourneyBadge';
import { AMBIENT_JOURNEYS_ENABLED } from '@src/journey/journeys-enabled';
import { NavBadge } from '@src/components/ui/nav-badge';
import { useLingui } from '@lingui/react/macro';
import { tagAttrs } from '@src/tags/tag-attrs';

/**
 * The collapsed icon rail's fixed width (Tailwind class). Single source of truth so
 * the Vibe-mode spacer that reserves this footprint (flow-page.tsx) can't drift.
 */
export const RAIL_WIDTH_CLASS = 'w-[50px]';
import { Bug, Mail, Plug } from 'lucide-react';
import React, { useMemo } from 'react';

// Membership AND order both come from RAIL_ITEMS (rail-visibility.ts). This file
// supplies each id's title/icon/target and renders the list in the order
// it arrives — it must never re-sort or filter it.
// RailIcon / HubItem live with the hub-rail builder so it can type its own return.

/** The tag word for a rail slot: `stream_inbox` -> `RailStream_inbox`. Derived rather than
 *  listed, so a new RAIL_ITEMS entry is observable and highlightable the moment
 *  it exists — one less thing to remember. */
export function railTag(id: string): string {
  return `Rail${id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')}`;
}

/** Stable empty rail for desk renders, so the memo below doesn't hand React a
 *  fresh array every time. */
const NO_HUB_ITEMS: readonly HubItem[] = [];

/** Title/icon/target for a DESK rail id. */
type NavItem = {
  title: string;
  icon: RailIcon;
  viewType: ViewType;
  open: () => void;
  badge?: number;
};

export function CollapsedSidebar() {
  const { navigation, currentDock } = useDockNavigation();
  const devMode = useIsDev();
  const { unread: unreadCount } = useStreamInboxManager();
  const { t } = useLingui();

  /** Title/icon/target per id. A LOOKUP, not an order — see RAIL_ITEMS. */
  const navMeta: Record<RailItemId, NavItem> = {
    stream_inbox: {
      title: t`Stream Inbox`,
      icon: Mail,
      viewType: ViewType.STREAM_INBOX,
      open: () => navigation.openTab(ViewType.STREAM_INBOX),
      badge: unreadCount,
    },
    // `Plug`, not the screen's own `KeyRound` (VIEWER_REGISTRY): a connection is
    // more than a key, and the rail reads better with a glyph per job. A literal is right here —
    // the CLAUDE.md registry rule governs per-ENTITY-TYPE icons, and this slot is
    // a screen, like `stream_inbox` beside it.
    // Not `openTab`: `openCredentials` puts the active project in the URL.
    credentials: {
      title: t`Connections`,
      icon: Plug,
      viewType: ViewType.CREDENTIALS,
      open: () => navigation.openCredentials(),
    },
  };

  // Hub page has its own minimal rail — Home + the browse entries. It bypasses
  // the desk RAIL_ITEMS entirely (those views don't exist on hub).
  const hubMode = currentDock?.page === PageId.HUB;
  // Built only in hub mode (desk is the common case — don't allocate/translate 7
  // unused entries every desk render).
  const hubItems = useMemo(() => (hubMode ? buildHubRailItems(t) : NO_HUB_ITEMS), [hubMode, t]);

  const currentView = currentDock?.viewType;
  const currentPointer = currentDock?.pointer ?? '';
  // Hub-rail active state: pointer-carrying items (WorldView world/organization,
  // records/<type>) match on viewType + pointer; the rest on viewType alone.
  const hubActive = (item: HubItem): boolean =>
    currentView === item.viewType && (!item.pointer || currentPointer === item.pointer);

  /** One desk rail entry, wrapped in its menu item. The entry at index 0 sits
   *  on the tab strip's line, so it carries the strip's own height — rail and
   *  tabs start AND end together under the nav bar. */
  const renderRailItem = (id: RailItemId, index: number) => {
    const meta = navMeta[id];
    const Icon = meta.icon;
    return (
      <SidebarMenuItem key={id}>
        <SidebarMenuButton
          tooltip={meta.title}
          data-rail-item={id}
          {...tagAttrs(railTag(id), 'button')}
          isActive={currentView === meta.viewType}
          onClick={meta.open}
          className={`relative w-full justify-center px-2 ${index === 0 ? TAB_LINE_HEIGHT_CLASS : ''}`}
        >
          <Icon className="h-5 w-5" />
          <NavBadge count={meta.badge ?? 0} />
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  /** One hub rail entry. The hub rail is a fixed list with its own active rule. */
  const renderHubItem = (item: HubItem, index = 1) => {
    const Icon = item.icon;
    return (
      <SidebarMenuItem key={`${item.id}:${item.pointer ?? ''}`}>
        <SidebarMenuButton
          tooltip={item.title}
          isActive={hubActive(item)}
          // Under page=hub: desk factories would revert the page.
          onClick={() => navigation.openPage(PageId.HUB, item.viewType, item.pointer)}
          data-rail-item={item.id}
          className={`relative w-full justify-center px-2 ${index === 0 ? TAB_LINE_HEIGHT_CLASS : ''}`}
        >
          <Icon className="h-5 w-5" />
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  return (
    <>
      {/* z-50 keeps the rail above the content column. It used to also be the
          number that let the bookmarks flyout (z-40) emerge from behind it;
          that menu now hangs off the top bar's star and out-ranks the rail
          deliberately (z-[60]), since it opens on the far side of the window. */}
      <Sidebar collapsible="none" className={`relative z-50 flex ${RAIL_WIDTH_CLASS} flex-col border-e`}>
        <SidebarContent className="flex-1">
          <SidebarGroup className="px-0 pb-2 pt-0">
            <SidebarMenu>{hubMode ? hubItems.map(renderHubItem) : RAIL_ITEMS.map(renderRailItem)}</SidebarMenu>
          </SidebarGroup>
        </SidebarContent>

        <div className="flex flex-col items-center gap-1 p-2">
          {devMode && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 animate-pulse text-orange-500 shadow-[0_0_8px_2px_rgba(249,115,22,0.6)] ring-1 ring-orange-500"
              onClick={() => window.setDev(false)}
              title={t`Dev mode ON — click to disable`}
            >
              <Bug className="h-4 w-4" />
            </Button>
          )}
          {AMBIENT_JOURNEYS_ENABLED && <JourneyBadge />}
          {/* Desk only: the hub rail already carries an `organization` entry to the
              same ViewType, and two buttons for one destination lights both. */}
          {!hubMode && <OrgTeamsButton />}
          <FlowpadAssistantButton />
          <ThemeToggle />
          <UserDropdown />
        </div>
      </Sidebar>
    </>
  );
}

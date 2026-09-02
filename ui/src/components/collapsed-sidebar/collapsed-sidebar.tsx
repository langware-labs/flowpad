import { markPerfT0, perfLog } from '@src/routes/loaders/_perf';
import { ThemeToggle } from '@src/components/theme-toggle/theme-toggle';
import { FlowpadAssistantButton } from '@src/components/floating-chat';
import { useIsDev, useViewMode, ViewMode } from '@src/components/view-mode';
import { buildHubRailItems, type HubItem, type RailIcon } from './hub-rail';
import { resolveRail, type RailGate, type RailItemId, type RailSpec } from './rail-visibility';
import { Button } from '@src/components/ui/button';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { EVENTS_VIEW_TYPES, ViewType } from '@src/types/ViewType';
import { useInboxManager } from '@src/hooks/useInboxManager';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@src/components/ui/sidebar';
import { AgenticProcess, DataSource, PageId, RagIndex } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { useHasConversations } from '@src/hooks/use-has-conversations';
import { useLastVibeChat } from '@src/pages/flow-page/vibe-process-resolver';
import { JourneyBadge } from '@src/journey/JourneyBadge';
import { NavBadge } from '@src/components/ui/nav-badge';
import { useLingui } from '@lingui/react/macro';
import { tagAttrs } from '@src/tags/tag-attrs';

/**
 * The collapsed icon rail's fixed width (Tailwind class). Single source of truth so
 * the Vibe-mode spacer that reserves this footprint (flow-page.tsx) can't drift.
 */
export const RAIL_WIDTH_CLASS = 'w-[50px]';
import { BadgeCheck, Bug, ChevronDown, Compass, History, KeyRound, Mail, RadioTower, Webhook, Workflow } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

// Membership AND order both come from RAIL_ITEMS (rail-visibility.ts). This file
// supplies each id's title/icon/target and renders the resolved list in the order
// it arrives — it must never re-sort or filter it. Every entry now renders
// through the one generic path; `discover` differs only in where its click goes.
// RailIcon / HubItem live with the hub-rail builder so it can type its own return.

/** The tag word for a rail slot: `chats` -> `RailChats`. Derived rather than
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

/** Title/icon/target for a DESK rail id. `viewType: null` = not a dock tab
 *  (the Discover route, which is a top-level page). */
type NavItem = {
  title: string;
  icon: RailIcon;
  viewType: ViewType | null;
};

export function CollapsedSidebar() {
  const { navigation, currentDock } = useDockNavigation();
  const navigate = useNavigate();
  const location = useLocation();
  const onDiscover = location.pathname === '/discover';
  const [secondaryExpanded, setSecondaryExpanded] = useState(false);
  const devMode = useIsDev();
  const { unread: unreadCount } = useInboxManager();
  const viewMode = useViewMode();
  // Derived, not a second useIsVibe() subscription — that hook IS this comparison.
  const isVibe = viewMode === ViewMode.Vibe;
  const openLastVibeChat = useLastVibeChat();
  const { t } = useLingui();

  const hasConversations = useHasConversations();

  /** Title/icon/target per id. A LOOKUP, not an order — see RAIL_ITEMS. */
  const navMeta: Partial<Record<RailItemId, NavItem>> = {
    // Glyph from the type registry (same rule as `data-sources` below): the rail
    // slot and an AgenticProcess entity are one thing to a user, so one TypeInfo.
    chats: { title: t`Chats`, icon: iconForType(AgenticProcess.type), viewType: ViewType.SHELL },
    inbox: { title: t`Inbox`, icon: Mail, viewType: ViewType.INBOX },
    discover: { title: t`Discover`, icon: Compass, viewType: null },
    events: { title: t`Events`, icon: RadioTower, viewType: ViewType.EVENTS },
    hooks: { title: t`Hooks`, icon: Webhook, viewType: ViewType.HOOKS },
    capabilities: { title: t`Capabilities`, icon: BadgeCheck, viewType: ViewType.CAPABILITIES },
    'llm-sources': { title: t`LLM sources`, icon: KeyRound, viewType: ViewType.LLM_SOURCES },
    'graph-workflows': { title: t`Graph Workflows`, icon: Workflow, viewType: ViewType.GRAPH_WORKFLOWS },
    // Glyph from the type registry, never a literal — same rule the project
    // item follows, so a TypeInfo icon change reaches the rail too.
    'data-sources': {
      title: t`Data sources`,
      icon: iconForType(DataSource.type),
      viewType: ViewType.DATA_SOURCES,
    },
    // Glyph from the type registry, never a literal — same rule the data-sources item follows.
    rag: { title: t`Search indexes`, icon: iconForType(RagIndex.type), viewType: ViewType.RAG },
    'process-runs': { title: t`Runs`, icon: History, viewType: ViewType.PROCESS_RUNS },
  };

  // Hub page has its own minimal rail — Home + the browse entries. It bypasses
  // the desk RAIL_ITEMS/mode matrix entirely (those views don't exist on hub).
  const hubMode = currentDock?.page === PageId.HUB;
  // Built only in hub mode (desk is the common case — don't allocate/translate 7
  // unused entries every desk render).
  const hubItems = useMemo(() => (hubMode ? buildHubRailItems(t) : NO_HUB_ITEMS), [hubMode, t]);

  // Content gates: an icon earns its slot only once the thing it opens exists.
  const gates: Record<RailGate, boolean> = {
    conversations: hasConversations,
  };
  const railItems = hubMode ? [] : resolveRail(viewMode, gates);
  const topItems = railItems.filter((item) => item.placement === 'top');
  const overflowItems = railItems.filter((item) => item.placement === 'overflow');

  const currentView = currentDock?.viewType;
  const currentPointer = currentDock?.pointer ?? '';
  // The project item owns EVERY assets surface, `list/task` and a task doc in
  // the editor included. It used to subtract those, because a Tasks rail entry
  // claimed them and one click must not light two buttons — that entry is gone,
  // so the subtraction would now just leave the rail dark on task URLs.

  // Hub-rail active state: pointer-carrying items (WorldView world/organization,
  // records/<type>) match on viewType + pointer; the rest on viewType alone.
  const hubActive = (item: HubItem): boolean =>
    currentView === item.viewType && (!item.pointer || currentPointer === item.pointer);

  const handleClick = useCallback(
    (viewType: ViewType | null, pointer?: string) => {
      // Hub page: keep every rail click under page=hub (desk factories would
      // revert the page). Home → /dock/hub/home; WorldView → /dock/hub/worldview/<projection>.
      if (hubMode) {
        navigation.openPage(PageId.HUB, viewType ?? ViewType.HOME, pointer);
        return;
      }
      if (viewType === null) {
        // The home is an ordinary destination now, so this goes through the one
        // navigation path like every other rail click. It used to read the live
        // browser URL directly and call `navigate('/')`, guarding against a
        // lagging `currentView` — `openDock` dedupes on the pointer itself.
        navigation.goHome();
      } else {
        if (viewType === ViewType.SHELL) {
          markPerfT0();
          perfLog('shell icon clicked');
        }
        // Assets is scope-aware: open the scope-keyed assets tab — the current
        // project's scope when a project is active (tab "<project>'s Assets"),
        // else global (the single "Assets" tab). Scope rides the navigation
        // scope filter (URL options), so the tab identity is the scope. Reached
        // only through the project item now; there is no separate Assets icon.
        if (viewType === ViewType.ASSETS) {
          navigation.openAssets();
          return;
        }
        navigation.openTab(viewType);
      }
    },
    [navigation, hubMode],
  );

  /** THE active-state resolver — used by top AND overflow entries alike, so an
   *  item can't mean one thing above the chevron and another below it. */
  const isActiveId = (id: RailItemId): boolean => {
    switch (id) {
      case 'discover':
        return onDiscover;
      // One rail item, four URLs: the merged screen answers to its own view
      // plus the three aliases it absorbed, so an old bookmark still lights the
      // icon it belongs to instead of leaving the rail looking unselected.
      case 'events':
        return EVENTS_VIEW_TYPES.has(currentView as ViewType);
      default:
        return currentView === navMeta[id]?.viewType;
    }
  };

  /** THE count chip resolver — likewise shared, so overflow entries keep their
   *  badges instead of silently dropping them. */
  const badgeForId = (id: RailItemId): number => {
    switch (id) {
      case 'inbox':
        return unreadCount;
      default:
        return 0;
    }
  };

  /** THE click router for desk rail entries. */
  const handleRailClick = (id: RailItemId) => {
    switch (id) {
      case 'discover':
        // Full-page marketplace: a top-level route, not a dock tab.
        void navigate('/discover');
        return;
      case 'chats':
        // Vibe has no chats list — resume the last real UI chat in the project.
        // TODO(nav): this is the ONE mode-dependent target the component still
        // resolves itself; `project` delegates to navigation.openAssets.
        // If a second one appears, move this into a
        // `navigation.openChats()` so every entry point (spotlight, shortcuts,
        // journeys) agrees. Not moved yet because useLastVibeChat is async and
        // hook-shaped while NavigationActions methods are sync.
        if (isVibe) {
          openLastVibeChat();
          return;
        }
        handleClick(ViewType.SHELL);
        return;
      default:
        handleClick(navMeta[id]?.viewType ?? null);
    }
  };

  /** One desk rail entry, wrapped in its menu item. */
  const renderRailItem = (spec: RailSpec) => {
    const meta = navMeta[spec.id];
    if (!meta) return null;
    const Icon = meta.icon;
    return (
      <SidebarMenuItem key={spec.id}>
        <SidebarMenuButton
          tooltip={meta.title}
          data-rail-item={spec.id}
          {...tagAttrs(railTag(spec.id), 'button')}
          isActive={isActiveId(spec.id)}
          onClick={() => handleRailClick(spec.id)}
          className="relative w-full justify-center px-2"
        >
          <Icon className="h-5 w-5" />
          <NavBadge count={badgeForId(spec.id)} />
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  /** One hub rail entry. The hub rail is a fixed list with its own active rule. */
  const renderHubItem = (item: HubItem) => {
    const Icon = item.icon;
    return (
      <SidebarMenuItem key={`${item.id}:${item.pointer ?? ''}`}>
        <SidebarMenuButton
          tooltip={item.title}
          isActive={hubActive(item)}
          onClick={() => handleClick(item.viewType, item.pointer)}
          data-rail-item={item.id}
          className="relative w-full justify-center px-2"
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
          <SidebarGroup className="px-0 py-2">
            <SidebarMenu>
              {hubMode ? hubItems.map(renderHubItem) : topItems.map(renderRailItem)}

              {overflowItems.length > 0 && (
                <div onMouseEnter={() => setSecondaryExpanded(true)} onMouseLeave={() => setSecondaryExpanded(false)}>
                  <div className="flex justify-center py-1">
                    <div
                      className={`flex h-5 w-8 items-center justify-center rounded-sm text-muted-foreground/50 transition-all duration-200 hover:bg-sidebar-accent hover:text-muted-foreground ${
                        secondaryExpanded ? 'rotate-180' : ''
                      }`}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </div>
                  </div>

                  {overflowItems.map((spec) => {
                    const shouldShow = secondaryExpanded || isActiveId(spec.id);

                    return (
                      <div
                        key={spec.id}
                        className={`overflow-hidden transition-all duration-200 ease-in-out ${
                          shouldShow ? 'max-h-10 opacity-100' : 'max-h-0 opacity-0'
                        }`}
                      >
                        {renderRailItem(spec)}
                      </div>
                    );
                  })}
                </div>
              )}
            </SidebarMenu>
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
          <JourneyBadge />
          <FlowpadAssistantButton />
          <ThemeToggle />
          <UserDropdown />
        </div>
      </Sidebar>
    </>
  );
}

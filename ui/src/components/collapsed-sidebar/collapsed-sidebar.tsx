import { ThemeToggle } from '@src/components/theme-toggle/theme-toggle';
import { FlowpadAssistantButton } from '@src/components/floating-chat';
import { useDevMode } from '@src/contexts/dev-mode-context';
import { useViewMode, ViewMode } from '@src/components/view-mode';
import { buildHubRailItems, type HubItem, type RailIcon } from './hub-rail';
import {
  resolveRail,
  type RailGate,
  type RailItemId,
  type RailSpec,
} from './rail-visibility';
import { Button } from '@src/components/ui/button';
import { useNavigationState } from '@src/hooks/use-navigation-state';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { useInboxManager } from '@src/hooks/useInboxManager';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@src/components/ui/sidebar';
import { PageId, Project } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { WikiTip } from '@src/components/wiki-tip';
import { useContext } from '@src/hooks/useContext';
import { useInboxStore } from '@src/store/use-inbox-store';
import { useProjectTasks } from '@src/hooks/use-project-tasks';
import { useHasConversations } from '@src/hooks/use-has-conversations';
import { useLastVibeChat } from '@src/pages/flow-page/use-last-vibe-chat';
import { isTaskActive } from '@src/components/task-bar/constants';
import { useSpotlightStore } from '@src/store/use-spotlight-store';
import { JourneyBadge } from '@src/journey/JourneyBadge';
import { tagAttrs } from '@src/tags/tag-attrs';
import { BookmarksSlider } from '@src/components/bookmarks-slider/BookmarksSlider';
import { useUnopenedFavoritesCount } from '@src/hooks/use-unopened-favorites-count';
import { useHoverIntent } from '@src/hooks/use-hover-intent';
import { useLingui } from '@lingui/react/macro';

/**
 * The collapsed icon rail's fixed width (Tailwind class). Single source of truth so
 * the Vibe-mode spacer that reserves this footprint (flow-page.tsx) can't drift.
 */
export const RAIL_WIDTH_CLASS = 'w-[50px]';
import {
  ArrowLeft,
  BadgeCheck,
  Bookmark,
  CheckSquare,
  RefreshCw,
  Bug,
  ChevronDown,
  Compass,
  FolderOpen,
  Home,
  Mail,
  MessageCircle,
  Search,
  Workflow,
  Webhook,
  Zap,
} from 'lucide-react';
import React, { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';

// Membership AND order both come from RAIL_ITEMS (rail-visibility.ts). This file
// supplies each id's title/icon/target and renders the resolved list in the order
// it arrives — it must never re-sort or filter it. The bespoke entries (project,
// bookmarks, discover) are ordinary members of that list; only their renderers
// live here, in `renderBespoke`.
// RailIcon / HubItem live with the hub-rail builder so it can type its own return.

/** Stable empty rail for desk renders, so the memo below doesn't hand React a
 *  fresh array every time. */
const NO_HUB_ITEMS: readonly HubItem[] = [];

/** Title/icon/target for a DESK rail id. `viewType: null` = not a dock tab
 *  (Home, and the bespoke Discover route). */
type NavItem = {
  title: string;
  icon: RailIcon;
  viewType: ViewType | null;
};

/** The rail's count chip. Shared by every rail button that carries one so they
 *  can't drift apart. Module scope, not the render body: a component declared
 *  inside render is a NEW type on every render, so React would remount the span
 *  rather than reconcile it. */
function NavBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-0.5 text-[9px] font-bold leading-none text-destructive-foreground">
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function CollapsedSidebar() {
  const { navigation, currentDock } = useDockNavigation();
  const { project } = useContext();
  const navigate = useNavigate();
  const location = useLocation();
  const onDiscover = location.pathname === '/discover';
  const { goBack, canGoBack } = useNavigationState();
  const [secondaryExpanded, setSecondaryExpanded] = useState(false);
  // Rest-to-open; the rail button and panel share one intent (see useHoverIntent).
  const bookmarks = useHoverIntent();
  // Align the menu's top edge with the button that opens it, so it reads as
  // belonging to that icon. Measured rather than a constant: the rail's layout
  // shifts with view mode and the collapsed-items expander.
  //
  // useLayoutEffect, not useEffect: a passive effect lands AFTER paint, so the
  // menu would render one frame at the fallback top and then jump to the button.
  const bookmarksBtnRef = useRef<HTMLButtonElement>(null);
  const [bookmarksAnchorTop, setBookmarksAnchorTop] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!bookmarks.open) return;
    setBookmarksAnchorTop(bookmarksBtnRef.current?.getBoundingClientRect().top);
  }, [bookmarks.open]);
  const devMode = useDevMode();
  const { unread: unreadCount } = useInboxManager();
  const unopenedFavorites = useUnopenedFavoritesCount();
  const viewMode = useViewMode();
  // Derived, not a second useIsVibe() subscription — that hook IS this comparison.
  const isVibe = viewMode === ViewMode.Vibe;
  const openLastVibeChat = useLastVibeChat();
  const { t } = useLingui();

  // Live count for the Tasks badge, and the Tasks existence gate. useProjectTasks
  // is scoped to the active project — the same corpus the `list/task` surface the
  // badge opens shows — and reactive (auto-refetches over WS on backend task
  // writes), so both track the graph without any polling here. Gate = "any task in
  // this project"; badge = the *active* ones, the subset needing attention now.
  const { data: tasks } = useProjectTasks();
  const activeTaskCount = tasks.filter(isTaskActive).length;
  const hasConversations = useHasConversations();

  /** Title/icon/target per id. A LOOKUP, not an order — see RAIL_ITEMS. */
  const navMeta: Partial<Record<RailItemId, NavItem>> = {
    home: { title: t`Home`, icon: Home, viewType: null },
    chats: { title: t`Chats`, icon: MessageCircle, viewType: ViewType.SHELL },
    inbox: { title: t`Inbox`, icon: Mail, viewType: ViewType.INBOX },
    tasks: { title: t`Tasks`, icon: CheckSquare, viewType: ViewType.TASKS },
    discover: { title: t`Discover`, icon: Compass, viewType: null },
    triggers: { title: t`Triggers`, icon: Zap, viewType: ViewType.TRIGGERS },
    hooks: { title: t`Hooks`, icon: Webhook, viewType: ViewType.HOOKS },
    files: { title: t`Files`, icon: FolderOpen, viewType: ViewType.EXPLORER },
    capabilities: { title: t`Capabilities`, icon: BadgeCheck, viewType: ViewType.CAPABILITIES },
    'agentic-flows': { title: t`Agentic Flows`, icon: Workflow, viewType: ViewType.AGENTIC_FLOWS },
  };

  // Hub page has its own minimal rail — Home + the browse entries. It bypasses
  // the desk RAIL_ITEMS/mode matrix entirely (those views don't exist on hub).
  const hubMode = currentDock?.page === PageId.HUB;
  // Built only in hub mode (desk is the common case — don't allocate/translate 7
  // unused entries every desk render).
  const hubItems = useMemo(() => (hubMode ? buildHubRailItems(t) : NO_HUB_ITEMS), [hubMode, t]);

  // Content gates: an icon earns its slot only once the thing it opens exists.
  const gates: Record<RailGate, boolean> = {
    project: !!project,
    conversations: hasConversations,
    tasks: tasks.length > 0,
  };
  const railItems = hubMode ? [] : resolveRail(viewMode, gates);
  const topItems = railItems.filter((item) => item.placement === 'top');
  const overflowItems = railItems.filter((item) => item.placement === 'overflow');

  const currentView = currentDock?.viewType;
  // Tasks ride the Assets viewType (`list/task`, or a task doc in the asset
  // editor), so "is Tasks active" can't come from currentView alone — it reads
  // the dock pointer. URL-first: derived from currentDock, never from an
  // upstream click. The project item subtracts it so one click doesn't light
  // two rail buttons.
  const currentPointer = currentDock?.pointer ?? '';
  const onTasks =
    currentView === ViewType.ASSETS &&
    (currentPointer.startsWith('list/task') || currentPointer.includes('/task/typeid/'));
  const onAssets = currentView === ViewType.ASSETS && !onTasks;

  // Hub-rail active state: pointer-carrying items (WorldView world/organization,
  // records/<type>) match on viewType + pointer; the rest on viewType alone.
  const hubActive = (item: HubItem): boolean =>
    currentView === item.viewType && (!item.pointer || currentPointer === item.pointer);

  const handleClick = useCallback(
    (viewType: ViewType | null, pointer?: string) => {
      // Hub page: keep every rail click under page=hub (desk factories would
      // revert the page). Home → /dock/hub/home; WorldView → /dock/hub/worldview/<projection>.
      if (hubMode) {
        navigation.openPage(PageId.HUB, viewType, pointer);
        return;
      }
      if (viewType === null) {
        if (import.meta.env.DEV) (window as Record<string, unknown>).__homeNavT0 = performance.now();
        // Guard on the LIVE browser URL: navigation.openDock commits via raw
        // pushState, which React Router's location can lag — currentView reads
        // stale-falsy on a real dock URL and would swallow this navigation.
        // TODO(nav): fix at the root — commit through the router in
        // NavigationActions (or reconcile currentDock against window.location in
        // use-navigation-state) so ALL consumers stop seeing stale locations.
        if (window.location.pathname !== '/') void navigate('/');
      } else {
        if (import.meta.env.DEV && viewType === ViewType.SHELL) {
          (window as Record<string, unknown>).__shellNavT0 = performance.now();
          console.log('[PERF] +0ms shell icon clicked');
        }
        // Tasks is not a dock tab of its own: ViewType.TASKS is retired, and a
        // task opens through the generic asset surface. openTasks() resolves to
        // the `list/task` asset list, so route through it rather than openTab
        // (which would land on the TasksRedirect shim and navigate twice).
        if (viewType === ViewType.TASKS) {
          navigation.openTasks();
          return;
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
    [navigate, navigation, hubMode],
  );

  /** THE active-state resolver — used by top AND overflow entries alike, so an
   *  item can't mean one thing above the chevron and another below it. */
  const isActiveId = (id: RailItemId): boolean => {
    switch (id) {
      case 'home':
        return !currentView;
      case 'project':
        return onAssets;
      case 'bookmarks':
        return bookmarks.open;
      case 'discover':
        return onDiscover;
      case 'tasks':
        return onTasks;
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
      case 'tasks':
        return activeTaskCount;
      case 'bookmarks':
        return unopenedFavorites;
      default:
        return 0;
    }
  };

  /** THE click router for desk rail entries. */
  const handleRailClick = (id: RailItemId) => {
    switch (id) {
      case 'bookmarks':
        bookmarks.set(!bookmarks.open);
        return;
      case 'discover':
        // Full-page marketplace: a top-level route, not a dock tab.
        void navigate('/discover');
        return;
      case 'project':
        handleClick(ViewType.ASSETS);
        return;
      case 'chats':
        // Vibe has no chats list — resume the last real UI chat in the project.
        // TODO(nav): this is the ONE mode-dependent target the component still
        // resolves itself; `tasks`/`project` delegate to navigation.openTasks/
        // openAssets. If a second one appears, move this into a
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

  /** The active project's rail button: opens that project's assets, behind the
   *  "Flowpad project" wiki page the footer's project name points at. The glyph
   *  is the project type's registry icon, never a hardcoded one. */
  const renderProjectItem = (proj: NonNullable<ReturnType<typeof useContext>['project']>) => {
    const ProjectIcon = iconForType(Project.type);
    return (
      /* side="right": the rail's regular tooltips open to the right; the
         WikiTip default (top) would pop the card above the button instead. */
      <WikiTip wikiword="Flowpad project" label={t`What is project?`} side="right">
        {/* Same tag as the footer's project name: a journey highlighting
            `ProjectPage` lights BOTH ways into the project, and a click on
            either emits the same bus target. */}
        <SidebarMenuButton
          {...tagAttrs('ProjectPage', 'button')}
          data-rail-item="project"
          isActive={isActiveId('project')}
          onClick={() => handleRailClick('project')}
          aria-label={t`Open project assets — ${proj.displayName}`}
          className="relative w-full justify-center px-2"
        >
          <ProjectIcon className="h-5 w-5" />
        </SidebarMenuButton>
      </WikiTip>
    );
  };

  /** The bookmarks button: opens the favorites desktop as a left slide-in flyout
   *  (not a dock tab), so it toggles local state rather than routing. */
  const renderBookmarksItem = () => (
    <SidebarMenuButton
      ref={bookmarksBtnRef}
      data-rail-item="bookmarks"
      // No tooltip: SidebarMenuButton places them side="right", i.e. on top of
      // the menu this opens. aria-label carries the name.
      aria-label={t`Bookmarks`}
      isActive={isActiveId('bookmarks')}
      {...bookmarks.hoverProps}
      onClick={() => handleRailClick('bookmarks')}
      // Keeps this click from registering as an outside-dismiss on the slider
      // and fighting the toggle.
      data-left-slider-ignore
      className="relative w-full justify-center px-2"
    >
      <Bookmark className="h-5 w-5" />
      <NavBadge count={badgeForId('bookmarks')} />
    </SidebarMenuButton>
  );

  /** Entries whose button isn't the generic one. Position still comes from
   *  RAIL_ITEMS — only the rendering is bespoke. */
  const renderBespoke = (id: RailItemId): ReactNode | null => {
    if (id === 'project') return project ? renderProjectItem(project) : null;
    if (id === 'bookmarks') return renderBookmarksItem();
    return null;
  };

  /** One desk rail entry, bespoke or generic, wrapped in its menu item. */
  const renderRailItem = (spec: RailSpec) => {
    const bespoke = renderBespoke(spec.id);
    if (bespoke) return <SidebarMenuItem key={spec.id}>{bespoke}</SidebarMenuItem>;
    const meta = navMeta[spec.id];
    if (!meta) return null;
    const Icon = meta.icon;
    return (
      <SidebarMenuItem key={spec.id}>
        <SidebarMenuButton
          tooltip={meta.title}
          data-rail-item={spec.id}
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

  // `bookmarks` is ungated and rides from Vibe, so it is present on every desk rail.
  const showBookmarksSlider = !hubMode;

  return (
    <>
      {/* Above the slider (z-40): the slider's closed transform parks it over the
          rail, where it would otherwise paint an opaque strip and swallow the
          rail's hover. On top, the menu emerges from behind the rail instead. */}
      <Sidebar collapsible="none" className={`relative z-50 flex ${RAIL_WIDTH_CLASS} flex-col border-r`}>
        <SidebarContent className="flex-1">
          <SidebarGroup className="px-0 py-2">
            <SidebarMenu>
              <SidebarMenuItem className="flex flex-row">
                <SidebarMenuButton
                  tooltip={t`Back`}
                  onClick={goBack}
                  disabled={!canGoBack}
                  className="h-6 w-1/2 justify-center px-0"
                >
                  <ArrowLeft className="h-3 w-3" />
                </SidebarMenuButton>
                <SidebarMenuButton
                  tooltip={t`Refresh`}
                  onClick={() => window.location.reload()}
                  className="h-6 w-1/2 justify-center px-0"
                >
                  <RefreshCw className="h-3 w-3" />
                </SidebarMenuButton>
              </SidebarMenuItem>

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
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => useSpotlightStore.getState().openSpotlight()}
            title={t`Search (⌘K)`}
            data-testid="sidebar-search-button"
          >
            <Search className="h-4 w-4" />
          </Button>
          <FlowpadAssistantButton />
          <ThemeToggle />
          <UserDropdown />
        </div>
      </Sidebar>
      {showBookmarksSlider && (
        <BookmarksSlider
          open={bookmarks.open}
          onOpenChange={bookmarks.set}
          hoverProps={bookmarks.hoverProps}
          anchorTop={bookmarksAnchorTop}
        />
      )}
    </>
  );
}

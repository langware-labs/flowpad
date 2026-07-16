import { ThemeToggle } from '@src/components/theme-toggle/theme-toggle';
import { FlowpadAssistantButton } from '@src/components/floating-chat';
import { useDevMode } from '@src/contexts/dev-mode-context';
import { DevOnly, ViewMode, useViewMode } from '@src/components/view-mode';
import { Button } from '@src/components/ui/button';
import { useNavigationState } from '@src/hooks/use-navigation-state';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@src/components/ui/sidebar';
import { Project } from '@sdk';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { WikiTip } from '@src/components/wiki-tip';
import { useContext } from '@src/hooks/useContext';
import { useInboxStore } from '@src/store/use-inbox-store';
import { useProjectTasks } from '@src/hooks/use-project-tasks';
import { isTaskActive } from '@src/components/task-bar/constants';
import { useSpotlightStore } from '@src/store/use-spotlight-store';
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
  BookOpen,
  Bug,
  ChevronDown,
  Compass,
  // Cloud,
  // CloudOff,
  // Code,
  // Cpu,
  FolderOpen,
  // Globe,
  Home,
  // KeyRound,
  Mail,
  MessageCircle,
  // PlaySquare,
  Search,
  // Settings,
  // Sparkles,
  // Workflow,
  // Variable,
  Webhook,
  Zap,
} from 'lucide-react';
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

// Per-item placement in the left rail, resolved by the current view mode.
//   visible   — shown at the top of the rail
//   collapsed — behind the chevron expander (revealed on hover, or when active)
//   hidden    — not rendered at all
// Keyed by ViewMode string values so this config reads exactly like the spec
// matrix. The hierarchy is dev > advanced > standard > vibe; keep each row
// monotonic (a higher mode never shows less than a lower one).
type NavVisibility = 'visible' | 'collapsed' | 'hidden';
type NavVisMap = Record<ViewMode, NavVisibility>;

const ALL_VISIBLE: NavVisMap = {
  [ViewMode.Vibe]: 'visible',
  [ViewMode.Standard]: 'visible',
  [ViewMode.Advanced]: 'visible',
  [ViewMode.Dev]: 'visible',
};

type NavItem = {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  viewType: ViewType | null;
  vis: NavVisMap;
};

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
  const { unreadCount } = useInboxStore();
  const unopenedFavorites = useUnopenedFavoritesCount();
  const viewMode = useViewMode();
  const { t } = useLingui();

  // Live count for the Tasks badge. useProjectTasks is an unscoped reactive
  // query (auto-refetches over WS on backend task writes), so the chip tracks
  // the graph without any polling here. We count *active* tasks — the ones
  // needing attention now — rather than every task ever created.
  const { data: tasks } = useProjectTasks();
  const activeTaskCount = tasks.filter(isTaskActive).length;

  const navItems: readonly NavItem[] = [
    { title: t`Home`, icon: Home, viewType: null, vis: ALL_VISIBLE },
    {
      title: t`Chats`,
      icon: MessageCircle,
      viewType: ViewType.SHELL,
      vis: {
        [ViewMode.Vibe]: 'hidden',
        [ViewMode.Standard]: 'visible',
        [ViewMode.Advanced]: 'visible',
        [ViewMode.Dev]: 'visible',
      },
    },
    { title: t`Inbox`, icon: Mail, viewType: ViewType.INBOX, vis: ALL_VISIBLE },
    { title: t`Tasks`, icon: CheckSquare, viewType: ViewType.TASKS, vis: ALL_VISIBLE },
    // { title: 'Execute Flow', icon: PlaySquare, viewType: ViewType.EXECUTE_FLOW, vis: ALL_VISIBLE },
    {
      title: t`Assets`,
      icon: BookOpen,
      viewType: ViewType.ASSETS,
      vis: {
        [ViewMode.Vibe]: 'hidden',
        [ViewMode.Standard]: 'hidden',
        [ViewMode.Advanced]: 'visible',
        [ViewMode.Dev]: 'visible',
      },
    },
    // { title: 'Editor', icon: Code, viewType: ViewType.EDITOR, vis: ALL_VISIBLE },
    {
      title: t`Triggers`,
      icon: Zap,
      viewType: ViewType.TRIGGERS,
      vis: {
        [ViewMode.Vibe]: 'hidden',
        [ViewMode.Standard]: 'hidden',
        [ViewMode.Advanced]: 'collapsed',
        [ViewMode.Dev]: 'collapsed',
      },
    },
    {
      title: t`Hooks`,
      icon: Webhook,
      viewType: ViewType.HOOKS,
      vis: {
        [ViewMode.Vibe]: 'hidden',
        [ViewMode.Standard]: 'hidden',
        [ViewMode.Advanced]: 'collapsed',
        [ViewMode.Dev]: 'collapsed',
      },
    },
    {
      title: t`Files`,
      icon: FolderOpen,
      viewType: ViewType.EXPLORER,
      vis: {
        [ViewMode.Vibe]: 'collapsed',
        [ViewMode.Standard]: 'collapsed',
        [ViewMode.Advanced]: 'collapsed',
        [ViewMode.Dev]: 'collapsed',
      },
    },
    {
      title: t`Capabilities`,
      icon: BadgeCheck,
      viewType: ViewType.CAPABILITIES,
      vis: {
        [ViewMode.Vibe]: 'hidden',
        [ViewMode.Standard]: 'hidden',
        [ViewMode.Advanced]: 'hidden',
        [ViewMode.Dev]: 'collapsed',
      },
    },
    // { title: 'Environment', icon: Variable, viewType: ViewType.ENVIRONMENT, vis: ALL_VISIBLE },
    // { title: 'Web App', icon: Globe, viewType: ViewType.WEB_APP, vis: ALL_VISIBLE },
    // { title: 'Connections', icon: LogIn, viewType: ViewType.CONNECTIONS, vis: ALL_VISIBLE },
    // { title: 'API Keys', icon: KeyRound, viewType: ViewType.API_KEYS, vis: ALL_VISIBLE },
    // { title: 'AI Configuration', icon: Settings, viewType: ViewType.AI_CONFIG, vis: ALL_VISIBLE },
    // { title: 'Machine', icon: Cpu, viewType: ViewType.MACHINE, vis: ALL_VISIBLE },
  ];

  // Partition the nav config by the current view mode: 'visible' items ride the
  // top rail, 'collapsed' items live behind the chevron expander, 'hidden' drop.
  // The back/refresh row and the bottom cluster are outside the matrix — they
  // render unconditionally below.
  const isVibe = viewMode === ViewMode.Vibe;
  const visibleItems = navItems.filter((item) => item.vis[viewMode] === 'visible');
  const collapsedItems = navItems.filter((item) => item.vis[viewMode] === 'collapsed');

  const currentView = currentDock?.viewType;
  // Tasks ride the Assets viewType (`list/task`, or a task doc in the asset
  // editor), so "is Tasks active" can't come from currentView alone — it reads
  // the dock pointer. URL-first: derived from currentDock, never from an
  // upstream click. Assets/project-home subtract it so one click doesn't light
  // two rail buttons.
  const currentPointer = currentDock?.pointer ?? '';
  const onTasks =
    currentView === ViewType.ASSETS &&
    (currentPointer.startsWith('list/task') || currentPointer.includes('/task/typeid/'));
  const onAssets = currentView === ViewType.ASSETS && !onTasks;
  // const { cloudLoginAvailable, cloudApiUrl, isDesktop } = context;

  const handleClick = useCallback(
    (viewType: ViewType | null) => {
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
        // scope filter (URL options), so the tab identity is the scope.
        if (viewType === ViewType.ASSETS) {
          // Default surface: project home when a project is active (scope-keyed
          // to it), else the global "all" list — resolved in openAssets.
          navigation.openAssets();
          return;
        }
        navigation.openTab(viewType);
      }
    },
    [navigate, navigation],
  );

  /** The rail's count chip. Shared by every rail button that carries one
   *  (Inbox unread, Bookmarks never-opened) so they can't drift apart — the
   *  Bookmarks button can't go through renderNavItem, since it has no viewType
   *  and toggles a flyout instead of navigating. */
  const NavBadge = ({ count }: { count: number }) =>
    count > 0 ? (
      <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-0.5 text-[9px] font-bold leading-none text-destructive-foreground">
        {count > 99 ? '99+' : count}
      </span>
    ) : null;

  /** The active project's rail button: opens that project's assets (the same
   *  scope-aware target the Assets item routes to), behind the "Flowpad project"
   *  wiki page the footer's project name points at. The glyph is the project
   *  type's registry icon, never a hardcoded one. */
  const renderProjectHomeItem = (proj: NonNullable<ReturnType<typeof useContext>['project']>) => {
    const ProjectIcon = iconForType(Project.type);
    return (
      <SidebarMenuItem>
        {/* side="right": the rail's regular tooltips open to the right; the
            WikiTip default (top) would pop the card above the button instead. */}
        <WikiTip wikiword="Flowpad project" label={t`What is project?`} side="right">
          <SidebarMenuButton
            isActive={onAssets}
            onClick={() => handleClick(ViewType.ASSETS)}
            aria-label={t`Open project assets — ${proj.displayName}`}
            className="relative w-full justify-center px-2"
          >
            <ProjectIcon className="h-5 w-5" />
          </SidebarMenuButton>
        </WikiTip>
      </SidebarMenuItem>
    );
  };

  /** The count chip a rail item carries, if any. */
  const navBadge = (viewType: ViewType | null): number | undefined => {
    if (viewType === ViewType.INBOX) return unreadCount;
    if (viewType === ViewType.TASKS) return activeTaskCount;
    return undefined;
  };

  /** Active state for items whose surface isn't identified by viewType alone
   *  (see `onTasks`). undefined → renderNavItem's default viewType match. */
  const navActive = (viewType: ViewType | null): boolean | undefined => {
    if (viewType === ViewType.TASKS) return onTasks;
    if (viewType === ViewType.ASSETS) return onAssets;
    return undefined;
  };

  const renderNavItem = (
    item: { title: string; icon: React.ComponentType<{ className?: string }>; viewType: ViewType | null },
    className?: string,
    badge?: number,
    activeOverride?: boolean,
  ) => {
    const Icon = item.icon;
    const isActive = activeOverride ?? (item.viewType === null ? !currentView : currentView === item.viewType);

    return (
      <SidebarMenuItem key={item.title} className={className}>
        <SidebarMenuButton
          tooltip={item.title}
          isActive={isActive}
          onClick={() => handleClick(item.viewType)}
          className="relative w-full justify-center px-2"
        >
          <Icon className="h-5 w-5" />
          <NavBadge count={badge ?? 0} />
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

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

              {visibleItems.map((item) => (
                <React.Fragment key={item.title}>
                  {renderNavItem(item, undefined, navBadge(item.viewType), navActive(item.viewType))}
                  {/* The active project — sits directly under Home. Not part of the
                    nav matrix: it exists only while a project is selected, and its
                    glyph is that project type's registry icon. */}
                  {item.viewType === null && project && renderProjectHomeItem(project)}
                </React.Fragment>
              ))}

              {/* Bookmarks — vibe-mode only. Opens the favorites desktop as a
                left slide-in flyout (not a dock tab), so it toggles local state
                rather than routing through handleClick/openTab. The
                data-left-slider-ignore marker keeps this click from registering
                as an outside-dismiss and fighting the toggle. */}
              {isVibe && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    ref={bookmarksBtnRef}
                    // No tooltip: SidebarMenuButton places them side="right", i.e.
                    // on top of the menu this opens. aria-label carries the name.
                    aria-label={t`Bookmarks`}
                    isActive={bookmarks.open}
                    {...bookmarks.hoverProps}
                    onClick={() => bookmarks.set(!bookmarks.open)}
                    data-left-slider-ignore
                    className="relative w-full justify-center px-2"
                  >
                    <Bookmark className="h-5 w-5" />
                    <NavBadge count={unopenedFavorites} />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}

              {/* Discover — full-page marketplace; a top-level route, not a dock tab,
                so it navigates directly rather than via navigation.openTab.
                Dev-only affordance (never shown in Vibe, which is not Dev). */}
              <DevOnly reserve={false}>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    tooltip={t`Discover`}
                    isActive={onDiscover}
                    onClick={() => void navigate('/discover')}
                    className="relative w-full justify-center px-2"
                  >
                    <Compass className="h-5 w-5" />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </DevOnly>

              {collapsedItems.length > 0 && (
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

                  {collapsedItems.map((item) => {
                    const isActive = currentView === item.viewType;
                    const shouldShow = secondaryExpanded || isActive;

                    return (
                      <div
                        key={item.title}
                        className={`overflow-hidden transition-all duration-200 ease-in-out ${
                          shouldShow ? 'max-h-10 opacity-100' : 'max-h-0 opacity-0'
                        }`}
                      >
                        {renderNavItem(item)}
                      </div>
                    );
                  })}
                </div>
              )}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>

        {/* {isDesktop && cloudApiUrl && (
        <div className="border-t border-sidebar-border p-2">
          <SidebarMenuButton
            tooltip={
              cloudLoginAvailable
                ? 'Cloud Connected - Click to open FlowPad Cloud'
                : 'Cloud Disconnected - Click to connect'
            }
            onClick={() =>
              cloudLoginAvailable ? window.open(cloudApiUrl, '_blank') : navigation.openTab(ViewType.CONNECTIONS)
            }
            className={`w-full justify-center px-2 ${cloudLoginAvailable ? 'text-green-500' : 'text-muted-foreground'}`}
            data-testid="cloud-login-button"
          >
            {cloudLoginAvailable ? <Cloud className="h-5 w-5" /> : <CloudOff className="h-5 w-5" />}
          </SidebarMenuButton>
        </div>
      )} */}

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
      {isVibe && (
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

import { ThemeToggle } from '@src/components/theme-toggle/theme-toggle';
import { useDevMode } from '@src/contexts/dev-mode-context';
import { Button } from '@src/components/ui/button';
import { useNavigationState } from '@src/hooks/use-navigation-state';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { useAuth } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { Sidebar, SidebarContent, SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@src/components/ui/sidebar';
import {
  ArrowLeft,
  RefreshCw,
  BookOpen,
  Bug,
  ChevronDown,
  // Cloud,
  // CloudOff,
  // Code,
  // Cpu,
  FolderOpen,
  // Globe,
  Home,
  // KeyRound,
  // MessagesSquare,
  // PlaySquare,
  // Settings,
  // Sparkles,
  // Workflow,
  Terminal,
  // Variable,
  Webhook,
  Zap,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

const mainNavItems = [
  { title: 'Home', icon: Home, viewType: null },
  { title: 'Shell', icon: Terminal, viewType: ViewType.SHELL },
  // { title: 'Execute Flow', icon: PlaySquare, viewType: ViewType.EXECUTE_FLOW },
  { title: 'Wiki', icon: BookOpen, viewType: ViewType.ASSETS },
  { title: 'Triggers', icon: Zap, viewType: ViewType.TRIGGERS },
] as const;

const secondaryNavItems = [
  // { title: 'Editor', icon: Code, viewType: ViewType.EDITOR },
  { title: 'Hooks', icon: Webhook, viewType: ViewType.HOOKS },
  // { title: 'Environment', icon: Variable, viewType: ViewType.ENVIRONMENT },
  { title: 'Files', icon: FolderOpen, viewType: ViewType.EXPLORER },
  // { title: 'Session', icon: MessagesSquare, viewType: ViewType.SESSION },
  // { title: 'Web App', icon: Globe, viewType: ViewType.WEB_APP },
  // { title: 'Connections', icon: LogIn, viewType: ViewType.CONNECTIONS },
  // { title: 'API Keys', icon: KeyRound, viewType: ViewType.API_KEYS },
  // { title: 'AI Configuration', icon: Settings, viewType: ViewType.AI_CONFIG },
  // { title: 'Machine', icon: Cpu, viewType: ViewType.MACHINE },
] as const;

export function CollapsedSidebar() {
  const { navigation, currentDock } = useDockNavigation();
  const { user } = useAuth();
  // const context = useContext();
  const navigate = useNavigate();
  const { goBack, canGoBack } = useNavigationState();
  const [secondaryExpanded, setSecondaryExpanded] = useState(false);
  const devMode = useDevMode();

  const currentView = currentDock?.viewType;
  // const { cloudLoginAvailable, cloudApiUrl, isDesktop } = context;

  const handleClick = useCallback(
    (viewType: ViewType | null) => {
      if (viewType === null) {
        (window as Record<string, unknown>).__homeNavT0 = performance.now();
        if (currentView) void navigate('/');
      } else {
        if (viewType === ViewType.SHELL) {
          (window as Record<string, unknown>).__shellNavT0 = performance.now();
          console.log('[PERF] +0ms shell icon clicked');
        }
        navigation.openTab(viewType);
      }
    },
    [currentView, navigate, navigation],
  );

  const renderNavItem = (
    item: { title: string; icon: React.ComponentType<{ className?: string }>; viewType: ViewType | null },
    className?: string,
  ) => {
    const Icon = item.icon;
    const isActive = item.viewType === null ? !currentView : currentView === item.viewType;

    return (
      <SidebarMenuItem key={item.title} className={className}>
        <SidebarMenuButton
          tooltip={item.title}
          isActive={isActive}
          onClick={() => handleClick(item.viewType)}
          className="w-full justify-center px-2"
        >
          <Icon className="h-5 w-5" />
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };

  return (
    <Sidebar collapsible="none" className="flex w-[50px] flex-col border-r">
      <SidebarContent className="flex-1">
        <SidebarGroup className="px-0 py-2">
          <SidebarMenu>
            <SidebarMenuItem className="flex flex-row">
              <SidebarMenuButton
                tooltip="Back"
                onClick={goBack}
                disabled={!canGoBack}
                className="h-6 w-1/2 justify-center px-0"
              >
                <ArrowLeft className="h-3 w-3" />
              </SidebarMenuButton>
              <SidebarMenuButton
                tooltip="Refresh"
                onClick={() => window.location.reload()}
                className="h-6 w-1/2 justify-center px-0"
              >
                <RefreshCw className="h-3 w-3" />
              </SidebarMenuButton>
            </SidebarMenuItem>

            {mainNavItems.map((item) => renderNavItem(item))}

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

              {secondaryNavItems.map((item) => {
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
            className="h-8 w-8 text-orange-500 ring-1 ring-orange-500 shadow-[0_0_8px_2px_rgba(249,115,22,0.6)] animate-pulse"
            onClick={() => window.setDev(false)}
            title="Dev mode ON — click to disable"
          >
            <Bug className="h-4 w-4" />
          </Button>
        )}
        <ThemeToggle />
        {user && <UserDropdown />}
      </div>
    </Sidebar>
  );
}

import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { CollapsedSidebar } from '@src/components/collapsed-sidebar';
import { Footer } from '@src/components/footer';
import { EnvVar, useEnvVarsStore } from '@src/hooks/use-env-vars-store';
import { EnvVarType } from '@src/types/envVarTypes';
import { useEntityEnv } from '@sdk/react/hooks';
import { SidebarProvider } from '@src/components/ui/sidebar';
import { useIsVibe } from '@src/components/view-mode';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { useEffect, useMemo } from 'react';
import { ContentPanel } from './content-panel/content-panel';
import { VibeWorkspace } from './vibe-workspace';
import { VibeNewChat } from './vibe-new-chat';
import { VibeNoProcessWorkspace } from './vibe-no-process-workspace';
import { useVibeWorkspaceSession } from './use-vibe-workspace-session';

export default function FlowPage() {
  const { flow } = useAgentContext();

  // Memoize the flow object to prevent unnecessary re-renders
  const memoizedFlow = useMemo(() => flow, [flow]);
  const { setEnvVars } = useEnvVarsStore();
  // Use the unified hook to fetch environment variables - only for logged-in users
  const { table } = useEntityEnv({
    entityTypeId: memoizedFlow?.projectTypeId,
  });

  // Convert table data to EnvVar[] for backward compatibility and set in store
  useEffect(() => {
    if (table?.values) {
      const envVars: EnvVar[] = table.values.map((row) => ({
        name: row.name,
        var_type: row.var_type as EnvVarType, // Type will be validated by EnvVarType
        description: row.description || '',
      }));
      setEnvVars(envVars);
    }
  }, [table, setEnvVars]);

  const isVibe = useIsVibe();
  // A Vibe "session" = a workspace surface: the process's own dock (the display
  // URL) OR a child tab opened from inside it. Resolved by one hook so the
  // "is this a workspace surface" shape lives in one place, reusable by any
  // future workspace-with-children view. Null on the bare home (centered prompt).
  const vibeSession = useVibeWorkspaceSession();
  // Any OTHER real dock URL in Vibe (project home, assets, a conversation…) is
  // not a workspace surface, but it is still a navigable destination — it must
  // render through the normal ContentPanel (which carries its own Vibe skin:
  // creator surfaces go chrome-less, everything else falls back to Standard
  // chrome). Only the bare home (no dock URL, or the HOME landing) gets the
  // VibeNewChat hero. Without this, clicking e.g. the footer project name
  // (→ /dock/project/<id>) fell through to VibeNewChat and the project home
  // never opened.
  const { isDockUrl, currentDock } = useDockNavigation();
  const isVibeHome = !isDockUrl || currentDock?.viewType === ViewType.HOME;
  const isVibeNoProcess = currentDock?.viewType === ViewType.HOME && currentDock.options?.vibeNoProcess === 'true';

  // Vibe mode: a stripped Lovable-style skin that still carries the left rail in
  // its already-reserved footprint. CollapsedSidebar renders a minimal rail in
  // Vibe — top navigation (back/refresh) + a Home button, and the shared bottom
  // cluster (search / assistant / theme / user login) — with the middle nav
  // (Chats, Inbox, Assets, …) dropped. Same width as Standard/Advanced, so the
  // content column and footer controls don't shift when the view mode changes.
  if (isVibe) {
    return (
      <SidebarProvider defaultOpen={false} className="h-full !min-h-0">
        <div data-testid="flow-page" className="flex h-full w-full overflow-hidden bg-background">
          <CollapsedSidebar />

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-hidden">
              {vibeSession ? (
                <VibeWorkspace session={vibeSession} />
              ) : isVibeNoProcess ? (
                <VibeNoProcessWorkspace />
              ) : isVibeHome ? (
                <VibeNewChat />
              ) : (
                <ContentPanel />
              )}
            </div>
            <Footer />
          </div>
        </div>
      </SidebarProvider>
    );
  }

  // New layout with collapsed sidebar and bottom terminal
  return (
    <SidebarProvider defaultOpen={false} className="h-full !min-h-0">
      <div data-testid="flow-page" className="flex h-full w-full overflow-hidden bg-background">
        {/* Collapsed Icon Sidebar (~50px wide) */}
        <CollapsedSidebar />

        {/* Main Content Area. min-w-0 is load-bearing: without it this
            flex-row child sizes to max-content and the unified tab strip
            (dozens of chips) blows the column out to thousands of px,
            pushing the right arrow / close-all / opener toolbar off-screen. */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Content Panel (full width) */}
          <div className="flex-1 overflow-hidden">
            <ContentPanel />
          </div>

          <Footer />
        </div>
      </div>
    </SidebarProvider>
  );
}

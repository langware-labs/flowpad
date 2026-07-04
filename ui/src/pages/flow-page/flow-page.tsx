import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { CollapsedSidebar, RAIL_WIDTH_CLASS } from '@src/components/collapsed-sidebar';
import { Footer } from '@src/components/footer';
import { EnvVar, useEnvVarsStore } from '@src/hooks/use-env-vars-store';
import { EnvVarType } from '@src/types/envVarTypes';
import { useEntityEnv } from '@sdk/react/hooks';
import { SidebarProvider } from '@src/components/ui/sidebar';
import { useIsVibe } from '@src/components/view-mode';
import { useEffect, useMemo } from 'react';
import { ContentPanel } from './content-panel/content-panel';
import { VibeWorkspace } from './vibe-workspace';
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

  // Vibe mode: no left rail (the chat panel owns the chrome), Lovable-style.
  // We still RESERVE the rail's footprint with an invisible spacer that mirrors
  // CollapsedSidebar's box (RAIL_WIDTH_CLASS + 1px right border) so the content
  // column — and the footer buttons inside it — sit at the exact same x-offset as
  // in Standard/Advanced. Without it, dropping the rail shifts everything left and
  // the footer controls jump when the view mode changes.
  if (isVibe) {
    return (
      <SidebarProvider defaultOpen={false} className="h-full !min-h-0">
        <div data-testid="flow-page" className="flex h-full w-full overflow-hidden bg-background">
          {/* Rail-width spacer (invisible border keeps the same footprint) */}
          <div aria-hidden className={`${RAIL_WIDTH_CLASS} shrink-0 border-r border-transparent`} />

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex-1 overflow-hidden">
              {vibeSession ? <VibeWorkspace session={vibeSession} /> : <ContentPanel />}
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

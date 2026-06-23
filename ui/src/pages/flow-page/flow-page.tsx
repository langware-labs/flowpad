import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { CollapsedSidebar } from '@src/components/collapsed-sidebar';
import { NavigatorSlot } from '@src/navigation/NavigatorSlot';
import { Footer } from '@src/components/footer';
import { EnvVar, useEnvVarsStore } from '@src/hooks/use-env-vars-store';
import { EnvVarType } from '@src/types/envVarTypes';
import { useEntityEnv } from '@sdk/react/hooks';
import { SidebarProvider } from '@src/components/ui/sidebar';
import { useEffect, useMemo } from 'react';
import { ContentPanel } from './content-panel/content-panel';

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

  // New layout with collapsed sidebar and bottom terminal
  return (
    <SidebarProvider defaultOpen={false} className="h-full !min-h-0">
      <div data-testid="flow-page" className="flex h-full w-full overflow-hidden bg-background">
        {/* Collapsed Icon Sidebar (~50px wide) */}
        <CollapsedSidebar />

        {/* Zone B — shared left-menu slot. Renders the active view's navigator
            (assets tree / workflows / docs / triggers / chats) or nothing. */}
        <NavigatorSlot />

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

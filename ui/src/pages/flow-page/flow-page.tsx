import { CollapsedSidebar } from '@src/components/collapsed-sidebar';
import { TopNavBar } from '@src/components/top-nav-bar/TopNavBar';
import { Footer } from '@src/components/footer';
import { SidebarProvider } from '@src/components/ui/sidebar';
import { useIsVibe } from '@src/components/view-mode';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockLayout, resolveDockLayout } from '@src/navigation/dock-layout';
import { ContentPanel } from './content-panel/content-panel';
import { VibeWorkspace } from './vibe-workspace';
import { VibeNewChat } from './vibe-new-chat';
import { VibeNoProcessWorkspace } from './vibe-no-process-workspace';
import { useVibeWorkspaceSession } from './use-vibe-workspace-session';
import { AssetVibeWorkspace } from './asset-vibe-workspace';

export default function FlowPage() {
  const isVibe = useIsVibe();
  // A Vibe "session" = a workspace surface: the process's own dock (its ONE
  // shell URL — vibe is a view mode, not a URL family) OR a child tab opened
  // from inside it. Null on the bare home (centered prompt).
  const vibeSession = useVibeWorkspaceSession();
  const { currentDock } = useDockNavigation();
  // The layout is ONE pure rule (docs/navigation/dock-loading.md, step 5) — this
  // component renders its answer and decides nothing itself.
  const { layout, assetChatBeside } = resolveDockLayout({
    dock: currentDock ?? null,
    isVibe,
    hasVibeSession: !!vibeSession,
  });

  return (
    /* `flex-col` on the provider's own root (it appends className to a flex div)
       rather than a wrapper of our own: that makes the navigation bar the app's
       REAL top — full window width, above the rail as well as the content. Its
       predecessor was rendered inside each home page, which put it below the
       rail's top edge and made it vanish on every non-home route. Neither the
       runtime signal nor the back button may depend on where you navigated.
       One mount, one place. */
    <SidebarProvider defaultOpen={false} className="h-full !min-h-0 flex-col overflow-hidden bg-background">
      <TopNavBar />
      <div data-testid="flow-page" className="flex min-h-0 w-full flex-1 overflow-hidden">
        {/* Collapsed Icon Sidebar (~50px wide) */}
        <CollapsedSidebar />

        {/* Main Content Area. min-w-0 is load-bearing: without it this
            flex-row child sizes to max-content and the unified tab strip
            (dozens of chips) blows the column out to thousands of px,
            pushing the right arrow / close-all / opener toolbar off-screen. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-hidden">
            {layout === DockLayout.ASSET_WORKSPACE ? (
              <AssetVibeWorkspace isVibe={assetChatBeside} session={vibeSession} />
            ) : layout === DockLayout.VIBE_WORKSPACE && vibeSession ? (
              <VibeWorkspace session={vibeSession} />
            ) : layout === DockLayout.VIBE_NO_PROCESS ? (
              <VibeNoProcessWorkspace />
            ) : layout === DockLayout.VIBE_NEW_CHAT ? (
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

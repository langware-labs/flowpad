import { CollapsedSidebar } from '@src/components/collapsed-sidebar';
import { EnvironmentBanner } from '@src/components/environment-banner/EnvironmentBanner';
import { Footer } from '@src/components/footer';
import { SidebarProvider } from '@src/components/ui/sidebar';
import { useIsVibe } from '@src/components/view-mode';
import { useDockNavigation, useIsHomeSurface } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { PageId } from '@sdk';
import { ContentPanel } from './content-panel/content-panel';
import { VibeWorkspace } from './vibe-workspace';
import { VibeNewChat } from './vibe-new-chat';
import { VibeNoProcessWorkspace } from './vibe-no-process-workspace';
import { useVibeWorkspaceSession } from './use-vibe-workspace-session';
import { isContentAssetDock } from '@src/navigation/content-asset-dock';
import { AssetVibeWorkspace } from './asset-vibe-workspace';

export default function FlowPage() {
  const isVibe = useIsVibe();
  // A Vibe "session" = a workspace surface: the process's own dock (its ONE
  // shell URL — vibe is a view mode, not a URL family) OR a child tab opened
  // from inside it. Resolved by one hook so the "is this a workspace surface"
  // shape lives in one place, reusable by any future workspace-with-children
  // view. Null on the bare home (centered prompt).
  const vibeSession = useVibeWorkspaceSession();
  // Any OTHER real dock URL in Vibe (project home, assets, a conversation…) is
  // not a workspace surface, but it is still a navigable destination — it must
  // render through the normal ContentPanel (which carries its own Vibe skin:
  // creator surfaces go chrome-less, everything else falls back to Standard
  // chrome). Only the bare home (no dock URL, or the HOME landing) gets the
  // VibeNewChat hero. Without this, clicking e.g. the footer project name
  // (→ /dock/project/<id>) fell through to VibeNewChat and the project home
  // never opened.
  const { currentDock } = useDockNavigation();
  const isHomeSurface = useIsHomeSurface();
  const isVibeNoProcess = currentDock?.viewType === ViewType.HOME && currentDock.options?.vibeNoProcess === 'true';
  // The hub page is its own SPA-surface — vibe skinning (a desk view-mode) does
  // not apply. Route it through the standard layout so ContentPanel's page=hub
  // dispatch renders HubHome / WorldView instead of the desk VibeNewChat hero.
  const hubMode = currentDock?.page === PageId.HUB;
  const isAssetContent = !!currentDock && !hubMode && isContentAssetDock(currentDock);

  // One common tree keeps asset/file ContentPanel ancestry stable while the URL
  // changes only its view mode. Non-asset Vibe destinations retain the existing
  // process-display/new-chat dispatch.
  return (
    /* `flex-col` on the provider's own root (it appends className to a flex div)
       rather than a wrapper of our own: that makes the environment banner the
       app's REAL top — full window width, above the rail as well as the content.
       It used to be rendered inside each home page, which put it below the
       rail's top edge and made it vanish on every non-home route. On a cloud
       sandbox or an agent's box, "which runtime am I on" must not depend on
       where you navigated. One mount, one place. */
    <SidebarProvider defaultOpen={false} className="h-full !min-h-0 flex-col overflow-hidden bg-background">
      <EnvironmentBanner />
      <div data-testid="flow-page" className="flex min-h-0 w-full flex-1 overflow-hidden">
        {/* Collapsed Icon Sidebar (~50px wide) */}
        <CollapsedSidebar />

        {/* Main Content Area. min-w-0 is load-bearing: without it this
            flex-row child sizes to max-content and the unified tab strip
            (dozens of chips) blows the column out to thousands of px,
            pushing the right arrow / close-all / opener toolbar off-screen. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-hidden">
            {isAssetContent ? (
              <AssetVibeWorkspace isVibe={isVibe} session={vibeSession} />
            ) : isVibe && !hubMode ? (
              vibeSession ? (
                <VibeWorkspace session={vibeSession} />
              ) : isVibeNoProcess ? (
                <VibeNoProcessWorkspace />
              ) : isHomeSurface ? (
                <VibeNewChat />
              ) : (
                <ContentPanel />
              )
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

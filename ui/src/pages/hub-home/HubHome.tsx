import { PageId, ViewType } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useProjects } from '@src/hooks/use-projects';
import { Building2, FolderGit2, Globe } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * HubHome — the hub page's landing. Mirrors the desktop app HOME (`HomeLanding`)
 * look (centered greeting + a hero band + cards) but uses ONLY hub-served data
 * (projects via `graph/project`; the Atlas via `graph/org_graph`). No desktop-only
 * surfaces (inbox/feed/scan/vibe-session), so nothing 404/422s against the hub.
 *
 * URL: /dock/hub/home  (page=hub, viewType=home → routed here by ContentPanel).
 */
export function HubHome() {
  const { t } = useLingui();
  const { currentUser } = useAuth();
  const { navigation } = useDockNavigation();
  const { projects } = useProjects();

  const firstName = currentUser?.name?.split(' ')[0] || 'there';

  const openAtlas = (root: 'world' | 'organization') =>
    navigation.openDock(new DockPointer(ViewType.ATLAS, root, undefined, undefined, PageId.HUB));

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10 sm:py-14">
        {/* Hero — greeting, same typographic treatment as HomeLanding */}
        <div className="flex flex-col items-center gap-3 text-center">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            <Trans>
              Hey{' '}
              <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
                {firstName}
              </span>
            </Trans>
          </h1>
          <p className="text-lg text-muted-foreground">
            <Trans>Explore your organization and everything you can reach.</Trans>
          </p>
        </div>

        {/* Primary cards — World + Organization (the Atlas) */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => openAtlas('world')}
            data-testid="hub-home-world"
            className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:bg-accent"
          >
            <Globe className="h-6 w-6 text-muted-foreground group-hover:text-foreground" />
            <span className="text-base font-semibold">
              <Trans>Your world</Trans>
            </span>
            <span className="text-sm text-muted-foreground">
              <Trans>Everything you can reach, as a live graph.</Trans>
            </span>
          </button>

          <button
            type="button"
            onClick={() => openAtlas('organization')}
            data-testid="hub-home-organization"
            className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-5 text-left transition-colors hover:bg-accent"
          >
            <Building2 className="h-6 w-6 text-muted-foreground group-hover:text-foreground" />
            <span className="text-base font-semibold">
              <Trans>Organization</Trans>
            </span>
            <span className="text-sm text-muted-foreground">
              <Trans>Teams and people across your org.</Trans>
            </span>
          </button>
        </div>

        {/* Projects — real hub data (graph/project) */}
        {projects && projects.length > 0 && (
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              <Trans>Projects</Trans>
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
                >
                  <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm" title={p.name ?? undefined}>
                    {p.name || t`Untitled project`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default HubHome;

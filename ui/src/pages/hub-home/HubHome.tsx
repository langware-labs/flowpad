import { PageId, ViewType } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useProjects } from '@src/hooks/use-projects';
import { useDesktops, type Step } from '@src/hooks/use-desktops';
import {
  Building2,
  CheckCircle,
  Circle,
  FolderGit2,
  Globe,
  Loader2,
  Monitor,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';

function StepIcon({ status }: { status: Step['status'] }) {
  if (status === 'loading') return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  if (status === 'success') return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
  if (status === 'error') return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />;
}

/**
 * HubHome — the hub page's landing. Mirrors the desktop app HOME (`HomeLanding`)
 * look (centered greeting + a hero band + cards) but uses ONLY hub-served data
 * (projects plus the shared WorldView API). No desktop-only
 * surfaces (inbox/feed/scan/vibe-session), so nothing 404/422s against the hub.
 *
 * URL: /dock/hub/home  (page=hub, viewType=home → routed here by ContentPanel).
 */
export function HubHome() {
  const { t } = useLingui();
  const { currentUser } = useAuth();
  const { navigation } = useDockNavigation();
  const { projects } = useProjects();
  const { desktops, launch, launching, steps, launchUrl, openDesktop, deleteDesktop, deletingId } = useDesktops();
  const launchStarted = steps.some((s) => s.status !== 'idle');

  const firstName = currentUser?.name?.split(' ')[0] || 'there';

  const openWorldView = (projection: 'world' | 'organization') =>
    navigation.openPage(PageId.HUB, ViewType.WORLDVIEW, projection);

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

        {/* Primary cards — WorldView projections */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => openWorldView('world')}
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
            onClick={() => openWorldView('organization')}
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
                <div key={p.id} className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
                  <FolderGit2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm" title={p.name ?? undefined}>
                    {p.name || t`Untitled project`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Desktops — cloud FlowPad instances running in E2B (ComputeNode flavor=workspace) */}
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            <Trans>Desktops</Trans>
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {desktops.map((d) => (
              <div
                key={d.id}
                data-testid="desktop-card"
                data-node-id={d.id}
                data-provider-id={d.node_provider_id}
                className="group flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
              >
                <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => void openDesktop(d)}
                  className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
                  title={d.name || undefined}
                  data-testid="desktop-open"
                >
                  {d.name || t`Desktop`}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteDesktop(d)}
                  disabled={deletingId === d.id}
                  aria-label={t`Delete desktop`}
                  data-testid="desktop-delete"
                  className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive disabled:opacity-50 group-hover:opacity-100"
                >
                  {deletingId === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                </button>
              </div>
            ))}

            {/* Launch a new desktop */}
            <button
              type="button"
              onClick={() => void launch()}
              disabled={launching}
              data-testid="new-desktop-button"
              className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
            >
              {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {launching ? <Trans>Launching…</Trans> : <Trans>New Desktop</Trans>}
            </button>
          </div>

          {/* Live launch progress */}
          {launchStarted && (
            <ul
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-card/50 px-4 py-3"
              data-testid="desktop-launch-steps"
            >
              {steps.map((step) => (
                <li key={step.id} className="flex items-center gap-2 text-xs" data-status={step.status}>
                  <StepIcon status={step.status} />
                  <span className={step.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}>
                    {step.label}
                  </span>
                  {step.detail && <span className="truncate text-muted-foreground/70">— {step.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          {launchUrl && (
            <a
              href={launchUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="desktop-launch-link"
              className="text-sm text-primary hover:underline"
            >
              <Trans>Open desktop →</Trans>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default HubHome;

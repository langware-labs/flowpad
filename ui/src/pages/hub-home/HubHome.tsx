import {
  CredentialsSubview,
  dataContext,
  ExecutionEnvironmentStatus,
  PageId,
  ViewType,
  WorldViewProjection,
} from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { credentialsPointer } from '@src/components/credentials-view/credentials-pointer';
import { DockPointer } from '@src/navigation/DockPointer';
import { useContext } from '@src/hooks/useContext';
import { useProjects } from '@src/hooks/use-projects';
import { useDesktops, nextDesktopName, type Step, type DesktopDetails } from '@src/hooks/use-desktops';
import { NewDesktopDialog } from './NewDesktopDialog';
import { EnvironmentBanner } from '@src/components/environment-banner/EnvironmentBanner';
import {
  Building2,
  CheckCircle,
  Circle,
  ExternalLink,
  FolderGit2,
  Globe,
  Loader2,
  KeyRound,
  Monitor,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

function StepIcon({ status }: { status: Step['status'] }) {
  if (status === 'loading') return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  if (status === 'success') return <CheckCircle className="h-3.5 w-3.5 text-green-500" />;
  if (status === 'error') return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />;
}

// Live desktop status styling, keyed off the backend `ExecutionEnvironmentStatus`
// (`ops/status`). `card` tints the whole desktop block so status reads at a glance.
const STATUS_STYLE: Record<ExecutionEnvironmentStatus, { dot: string; card: string }> = {
  [ExecutionEnvironmentStatus.READY]: { dot: 'bg-green-500', card: 'border-green-500/40 bg-green-500/5' },
  [ExecutionEnvironmentStatus.PAUSED]: { dot: 'bg-yellow-500', card: 'border-yellow-500/40 bg-yellow-500/5' },
  [ExecutionEnvironmentStatus.NOT_FOUND]: { dot: 'bg-muted-foreground/40', card: 'border-border opacity-60' },
  [ExecutionEnvironmentStatus.ERROR]: { dot: 'bg-destructive', card: 'border-destructive/40 bg-destructive/5' },
  [ExecutionEnvironmentStatus.NEW]: { dot: 'bg-muted-foreground/40', card: 'border-border' },
};

/** Border/background tint for a desktop card, by live status. */
function statusCardClass(status?: ExecutionEnvironmentStatus): string {
  return (status && STATUS_STYLE[status]?.card) || 'border-border';
}

/** "12m", "1h 5m" — minutes granularity, clamped at 0. */
function fmtDur(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtSize(cpu?: number, memMb?: number): string | null {
  if (!cpu || !memMb) return null;
  const mem = memMb >= 1024 ? `${(memMb / 1024).toFixed(memMb % 1024 ? 1 : 0)} GiB` : `${memMb} MiB`;
  return `${cpu} vCPU · ${mem}`;
}

/** Second line of a desktop card: dot + label + (for running) time used / pauses-in + size. */
function DesktopStatus({ info, now }: { info?: DesktopDetails; now: number }) {
  const { t } = useLingui();
  if (!info) {
    return (
      <span className="flex items-center gap-1.5 pl-7 text-[11px] text-muted-foreground/50">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/40" />
        {t`Checking…`}
      </span>
    );
  }
  const status = info.status;
  const labels: Record<ExecutionEnvironmentStatus, string> = {
    [ExecutionEnvironmentStatus.READY]: t`Running`,
    [ExecutionEnvironmentStatus.PAUSED]: t`Paused`,
    [ExecutionEnvironmentStatus.NOT_FOUND]: t`Not found`,
    [ExecutionEnvironmentStatus.ERROR]: t`Unreachable`,
    [ExecutionEnvironmentStatus.NEW]: t`New`,
  };
  const parts: string[] = [];
  if (status === ExecutionEnvironmentStatus.READY) {
    if (info.started_at) parts.push(`${fmtDur(now - new Date(info.started_at).getTime())} used`);
    if (info.end_at) parts.push(`pauses in ${fmtDur(new Date(info.end_at).getTime() - now)}`);
  }
  const size = fmtSize(info.cpu_count, info.memory_mb);
  if (size) parts.push(size);
  return (
    <span className="flex min-w-0 items-center gap-1.5 pl-7 text-[11px] text-muted-foreground" title={status}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[status]?.dot ?? 'bg-muted-foreground/40'}`} />
      <span className="shrink-0">{labels[status] ?? status}</span>
      {parts.length > 0 && <span className="truncate text-muted-foreground/70">· {parts.join(' · ')}</span>}
    </span>
  );
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

  /** Open the Credentials view on its Environment tab.
   *
   *  Navigation and nothing else — no context writes, per the URL-first rule.
   *  `openPage` and not `openDock`: this card lives on the hub page, and a
   *  page-less pointer is redirected straight back to /dock/hub/home by
   *  `pageRedirectUrl` on a hub-only server.
   *
   *  Deliberately does NOT attach anything inline: these cards drive a HUB
   *  backend, which does not have the attach actions, so the panel shows its
   *  own empty state there rather than this button pretending to work. */
  const openDesktopSecrets = () => {
    navigation.openPage(PageId.HUB, ViewType.CREDENTIALS, credentialsPointer(CredentialsSubview.ENVIRONMENT));
  };
  // Current project is the same source the footer's StatusBar reads
  // (dataContext.project), so the highlighted card and the footer always agree.
  const { project: currentProject } = useContext();
  const { projects } = useProjects();
  const {
    desktops,
    launch,
    launching,
    steps,
    launchUrl,
    openDesktop,
    renameDesktop,
    deleteDesktop,
    deletingId,
    details,
  } = useDesktops();
  const launchStarted = steps.some((s) => s.status !== 'idle');
  // Absent on older hubs that don't advertise the flag yet — treat as enabled.
  const desktopsEnabled = dataContext.bootstrapInfo?.desktops_enabled !== false;
  // Creating a desktop needs BOTH a provisioning-capable hub (e2b key) and a
  // signed-in user — a visitor's launch would just 401.
  const canCreateDesktop = desktopsEnabled && !!currentUser;

  // Inline rename: single-click a desktop name to edit it.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  // Tick every 30s so the "used / pauses in" countdowns stay live without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // New-desktop modal (name + optional git). Opened by the New Desktop card, or
  // pre-filled from a `?setup_git=<git-url>` deep link.
  // One state: null = closed. Open sites can't disagree about the prefill.
  const [newDesktop, setNewDesktop] = useState<{ gitUrl?: string } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gitUrl = params.get('setup_git');
    if (!gitUrl) return;
    // Clean the URL so a refresh doesn't re-open.
    const url = new URL(window.location.href);
    url.searchParams.delete('setup_git');
    window.history.replaceState(null, '', url.toString());
    setNewDesktop({ gitUrl });
  }, []);

  const firstName = currentUser?.name?.split(' ')[0] || 'there';

  const openWorldView = (projection: WorldViewProjection) =>
    navigation.openPage(PageId.HUB, ViewType.WORLDVIEW, projection);

  return (
    <div className="flex h-full flex-col overflow-auto">
      <EnvironmentBanner />
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
            onClick={() => openWorldView(WorldViewProjection.WORLD)}
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
            onClick={() => openWorldView(WorldViewProjection.ORGANIZATION)}
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
              {projects.map((p) => {
                const isCurrent = currentProject?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={isCurrent}
                    // Clicking opens the project dock, which sets CurrentProject
                    // context — the same navigation the footer's name button uses,
                    // so the footer follows the click. URL-first: only openDock.
                    onClick={() => navigation.openDock(DockPointer.forProject(p.id))}
                    className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:bg-accent ${
                      isCurrent ? 'border-primary bg-primary/5' : 'border-border bg-card'
                    }`}
                    title={p.displayName}
                  >
                    <FolderGit2
                      className={`h-4 w-4 shrink-0 ${isCurrent ? 'text-primary' : 'text-muted-foreground'}`}
                    />
                    <span className="truncate text-sm">{p.displayName || t`Untitled project`}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Desktops — cloud FlowPad instances running in E2B (ComputeNode flavor=workspace) */}
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            <Trans>Desktops</Trans>
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* New desktop — always first, high-contrast + theme-aware. */}
            <Tooltip>
              <TooltipTrigger asChild>
                {/* span keeps the tooltip working while the button is disabled */}
                <span className="flex" tabIndex={canCreateDesktop ? -1 : 0}>
                  <button
                    type="button"
                    onClick={() => setNewDesktop({})}
                    disabled={launching || !canCreateDesktop}
                    data-testid="new-desktop-button"
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-primary/20 bg-primary/10 px-4 py-3 text-sm font-semibold text-primary transition-colors hover:bg-primary/20 disabled:pointer-events-none disabled:border-primary/20 disabled:bg-primary/5"
                  >
                    {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {launching ? <Trans>Launching…</Trans> : <Trans>New Desktop</Trans>}
                  </button>
                </span>
              </TooltipTrigger>
              {!canCreateDesktop && (
                <TooltipContent>
                  {!desktopsEnabled ? <Trans>Sandbox unavailable</Trans> : <Trans>Sign in to create desktops</Trans>}
                </TooltipContent>
              )}
            </Tooltip>

            {desktops.map((d) => (
              <div
                key={d.id}
                data-testid="desktop-card"
                data-node-id={d.id}
                data-provider-id={d.node_provider_id}
                data-status={details[d.id]?.status}
                title={desktopsEnabled ? undefined : t`Sandbox unavailable`}
                className={`group flex flex-col gap-1.5 rounded-lg border bg-card px-4 py-3 transition-colors ${statusCardClass(
                  details[d.id]?.status,
                )} ${desktopsEnabled ? '' : 'opacity-60'}`}
              >
                <div className="flex items-center gap-3">
                  <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {editingId === d.id ? (
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={() => {
                        void renameDesktop(d, draftName);
                        setEditingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        else if (e.key === 'Escape') setEditingId(null);
                      }}
                      data-testid="desktop-name-input"
                      className="min-w-0 flex-1 border-b border-border bg-transparent text-sm outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setDraftName(d.name || '');
                        setEditingId(d.id);
                      }}
                      disabled={!desktopsEnabled}
                      className="min-w-0 flex-1 truncate text-left text-sm hover:underline disabled:pointer-events-none"
                      title={desktopsEnabled ? t`Click to rename` : undefined}
                      data-testid="desktop-name"
                    >
                      {d.name || t`Desktop`}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void openDesktop(d)}
                    disabled={!desktopsEnabled}
                    aria-label={t`Open desktop`}
                    data-testid="desktop-open"
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground disabled:pointer-events-none disabled:opacity-50 group-hover:opacity-100"
                  >
                    <ExternalLink className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={openDesktopSecrets}
                    disabled={!desktopsEnabled}
                    aria-label={t`Machine secrets`}
                    data-testid="desktop-secrets"
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  >
                    <KeyRound className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteDesktop(d)}
                    disabled={deletingId === d.id || !desktopsEnabled}
                    aria-label={t`Delete desktop`}
                    data-testid="desktop-delete"
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive disabled:pointer-events-none disabled:opacity-50 group-hover:opacity-100"
                  >
                    {deletingId === d.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <DesktopStatus info={details[d.id]} now={now} />
              </div>
            ))}
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

      {/* New-desktop modal: name + optional git repo (with the connect-GitHub gate). */}
      <NewDesktopDialog
        open={!!newDesktop}
        onOpenChange={(o) => {
          if (!o) setNewDesktop(null);
        }}
        defaultName={nextDesktopName(desktops)}
        initialGitUrl={newDesktop?.gitUrl}
        onLaunch={(opts) => void launch(opts)}
      />
    </div>
  );
}

export default HubHome;

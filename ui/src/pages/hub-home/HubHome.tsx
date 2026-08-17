import {
  type ComputeNode,
  CredentialsSubview,
  dataContext,
  dataManager,
  ExecutionEnvironmentStatus,
  PageId,
  Project,
  TypeId,
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
import { ProjectActionsRow } from '@src/components/open-project-component/project-actions-row';
import { DesktopTile } from '@src/components/quick-create/QuickCreatePanel';
import { useSandboxes, isLaunched, nextSandboxName, type SandboxDetails } from '@src/hooks/use-sandboxes';
import { StepList } from '@src/components/ui/step-list';
import { NewSandboxDialog } from './NewSandboxDialog';
import { LaunchSandboxDialog } from './LaunchSandboxDialog';
import { ShareSandboxDialog } from './ShareSandboxDialog';
import { MembershipInvitations } from '@src/components/inbox-view/MembershipInvitations';
import { TokenPlanCard } from '@src/components/token-plan/TokenPlanCard';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { notify } from '@src/notifications';
import { Building2, FolderGit2, Globe, KeyRound, Loader2, LogOut, Monitor, Trash2, UserPlus } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Trans, useLingui } from '@lingui/react/macro';
import { consumeInboundParams } from '@src/navigation/inbound-link';
import { useEffect, useRef, useState } from 'react';

// Live sandbox status styling, keyed off the backend `ExecutionEnvironmentStatus`
// (`ops/status`). `card` tints the whole sandbox block so status reads at a glance.
const STATUS_STYLE: Record<ExecutionEnvironmentStatus, { dot: string; card: string }> = {
  [ExecutionEnvironmentStatus.READY]: { dot: 'bg-green-500', card: 'border-green-500/40 bg-green-500/5' },
  [ExecutionEnvironmentStatus.PAUSED]: { dot: 'bg-yellow-500', card: 'border-yellow-500/40 bg-yellow-500/5' },
  [ExecutionEnvironmentStatus.NOT_FOUND]: { dot: 'bg-muted-foreground/40', card: 'border-border opacity-60' },
  [ExecutionEnvironmentStatus.ERROR]: { dot: 'bg-destructive', card: 'border-destructive/40 bg-destructive/5' },
  [ExecutionEnvironmentStatus.NEW]: { dot: 'bg-muted-foreground/40', card: 'border-border' },
};

/** Border/background tint for a sandbox card, by live status. */
function statusCardClass(status?: ExecutionEnvironmentStatus): string {
  return (status && STATUS_STYLE[status]?.card) || 'border-border';
}

/** "12m", "1h 5m" — minutes granularity, clamped at 0. */
function fmtDur(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Is this box running the viewer's own cloud session?
 *
 * Reads the node's cached `logged_in_user` rather than probing the box: the hub
 * refreshes it whenever it brings the workspace up, so this costs nothing and
 * cannot wake a paused machine just to render a card. The trade is staleness —
 * a box signed out by some other route still advertises the old user until the
 * hub next talks to it, so the button can appear for a session that has already
 * ended. Signing out twice is harmless, which is why the cheap read wins.
 *
 * Exported for the unit test: the comparison rule (normalize, require both
 * sides, never match on empty) is the whole behaviour worth pinning.
 */
export function isSignedInAsMe(node: { logged_in_user?: string | null }, myEmail?: string | null): boolean {
  const boxUser = (node.logged_in_user ?? '').trim().toLowerCase();
  const me = (myEmail ?? '').trim().toLowerCase();
  // Both must be present: two unknowns are not a match, and treating them as one
  // would offer the button on every box of a signed-out viewer.
  return !!boxUser && !!me && boxUser === me;
}

function fmtSize(cpu?: number, memMb?: number): string | null {
  if (!cpu || !memMb) return null;
  const mem = memMb >= 1024 ? `${(memMb / 1024).toFixed(memMb % 1024 ? 1 : 0)} GiB` : `${memMb} MiB`;
  return `${cpu} vCPU · ${mem}`;
}

/**
 * Second line of a sandbox card: dot + label + (for running) time used /
 * pauses-in + size, then who the box is signed in as.
 *
 * The sign-in half comes from the node itself (`logged_in_user`), which the hub
 * caches whenever it brings the workspace up — so it costs nothing to render and
 * does not wake a paused machine to ask. Before this you could only learn whose
 * session a shared box was running by opening the share dialog.
 */
function SandboxStatus({
  info,
  now,
  launched = true,
  launching = false,
  loggedInUser,
  autoLogin,
}: {
  info?: SandboxDetails;
  now: number;
  /** Has this box ever been booted? An unlaunched one has no status to probe. */
  launched?: boolean;
  /** Is it booting right now? */
  launching?: boolean;
  loggedInUser?: string | null;
  autoLogin?: boolean;
}) {
  const { t } = useLingui();
  // The login half comes from the ENTITY, not from the status probe, so it must
  // render even while the probe is outstanding — and even if it never lands. A
  // box whose status is unreachable is exactly when "who is this signed in as"
  // is worth reading.
  // Its OWN row, not appended to the status line. Sharing a row meant competing
  // for width with "Running · 12m used · pauses in 3h · 2 vCPU · 2 GiB" inside a
  // `truncate`, and the sign-in — the half you cannot get anywhere else on this
  // page — was the part that disappeared.
  const login = (
    <span className="flex min-w-0 items-center gap-1.5 ps-7 text-[11px] text-muted-foreground">
      <LoginLine loggedInUser={loggedInUser} autoLogin={autoLogin} />
    </span>
  );
  // Never launched: there is no machine to have a status. Saying "Checking…"
  // here would be a probe that is never coming, and "Unreachable" would blame a
  // box that was never built.
  if (!launched) {
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 ps-7 text-[11px] text-muted-foreground/50">
          <span
            className={`h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40 ${launching ? 'animate-pulse' : ''}`}
          />
          <span data-testid="sandbox-not-launched">{launching ? t`Starting…` : t`Not started`}</span>
        </span>
      </div>
    );
  }
  if (!info) {
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 ps-7 text-[11px] text-muted-foreground/50">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/40" />
          {t`Checking…`}
        </span>
        {login}
      </div>
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
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5 ps-7 text-[11px] text-muted-foreground" title={status}>
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[status]?.dot ?? 'bg-muted-foreground/40'}`} />
        <span className="shrink-0">{labels[status] ?? status}</span>
        {parts.length > 0 && <span className="truncate text-muted-foreground/70">· {parts.join(' · ')}</span>}
      </span>
      {login}
    </div>
  );
}

/** Who the box is signed in as, and whether it still signs itself in. */
function LoginLine({ loggedInUser, autoLogin }: { loggedInUser?: string | null; autoLogin?: boolean }) {
  const { t } = useLingui();
  return (
    <>
      {/* `null` covers both "signed out" and "never looked" — indistinguishable
          from here, and the honest rendering of both is the same. */}
      {/* No leading separator any more: this renders on its own row, where a
          dangling "·" reads as a missing first item rather than a join. */}
      {loggedInUser ? (
        <span className="truncate text-muted-foreground/70" data-testid="sandbox-user">
          {t`signed in as ${loggedInUser}`}
        </span>
      ) : (
        <span className="shrink-0 text-muted-foreground/50" data-testid="sandbox-user-none">
          {t`signed out`}
        </span>
      )}
      {autoLogin === false && (
        <span className="shrink-0 text-muted-foreground/50" data-testid="sandbox-auto-login-off">
          · {t`auto-login off`}
        </span>
      )}
    </>
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
  const openSandboxSecrets = () => {
    navigation.openPage(PageId.HUB, ViewType.CREDENTIALS, credentialsPointer(CredentialsSubview.ENVIRONMENT));
  };
  // Current project is the same source the footer's StatusBar reads
  // (dataContext.project), so the highlighted card and the footer always agree.
  const { project: currentProject } = useContext();
  const { projects, refetch: refetchProjects } = useProjects();
  const {
    sandboxes,
    createSandbox,
    launchSandbox,
    launchingId,
    creating,
    steps,
    openSandbox,
    renameSandbox,
    deleteSandbox,
    deletingId,
    logoutSandbox,
    loggingOutId,
    details,
    refetch,
  } = useSandboxes();
  // Absent on older hubs that don't advertise the flag yet — treat as enabled.
  const sandboxesEnabled = dataContext.bootstrapInfo?.sandboxes_enabled !== false;
  // Creating a sandbox needs BOTH a provisioning-capable hub (e2b key) and a
  // signed-in user — a visitor's launch would just 401.
  const canCreateSandbox = sandboxesEnabled && !!currentUser;

  // Deleting a project. Held as the whole entity, not an id, so the confirm can
  // name what it is about to destroy.
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<Project | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);

  /**
   * Delete a project on the hub.
   *
   * `dataManager.delete` and NOT `Project.deleteWithChildren()`: that action is
   * a flow_sdk route the hub does not register, so it would 404 here. The hub's
   * generic entity DELETE is what exists (`graph_crud_actions.handle_delete_by_id`,
   * owner-only), and it drops the project row itself.
   */
  const deleteProject = async (project: Project) => {
    setDeletingProjectId(project.id);
    try {
      await dataManager.delete(new TypeId(Project.type, project.id));
      await refetchProjects();
      notify.success({ title: t`Deleted ${project.displayName}` });
    } catch (e) {
      // The hub refuses a delete the caller doesn't own with a message worth
      // reading, so surface it instead of failing silently.
      const ax = e as { response?: { data?: { message?: string } }; message?: string };
      notify.error({
        title: t`Couldn't delete the project.`,
        message: ax.response?.data?.message ?? ax.message,
      });
    } finally {
      setDeletingProjectId(null);
    }
  };

  // Inline rename: single-click a sandbox name to edit it.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  // Tick every 30s so the "used / pauses in" countdowns stay live without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // New-sandbox modal (name + optional git). Opened by the New Sandbox card, or
  // pre-filled from a `?setup_git=<git-url>` deep link.
  // One state: null = closed. Open sites can't disagree about the prefill.
  const [newSandbox, setNewSandbox] = useState<{ gitUrl?: string } | null>(null);
  // The sandbox whose share dialog is open, or null. Holds the node itself so
  // the dialog can read `auto_login` without a second fetch.
  const [sharing, setSharing] = useState<ComputeNode | null>(null);
  // The never-launched sandbox whose launch dialog is open, or null. Launching
  // asks first because it is the click that starts costing money, and because
  // auto-login can only be chosen before the box signs anyone in. Opening an
  // already-launched box stays one click — it asks nothing and starts nothing.
  const [launching, setLaunching] = useState<ComputeNode | null>(null);
  // Drives the "accepting adds it below" hint, and lets the sandbox list
  // refresh once an invitation is accepted (the granted node appears in it).
  const [pendingInviteCount, setPendingInviteCount] = useState(0);
  const prevPendingInvites = useRef(0);
  useEffect(() => {
    // A count that DROPS means one was accepted or declined; on accept the
    // recipient now holds a role on the node, so the list below is stale.
    if (pendingInviteCount < prevPendingInvites.current) void refetch();
    prevPendingInvites.current = pendingInviteCount;
  }, [pendingInviteCount, refetch]);
  useEffect(() => {
    // Read-and-scrub in one call, so a refresh cannot re-open the dialog.
    const { setup_git: gitUrl } = consumeInboundParams(['setup_git']);
    if (!gitUrl) return;
    setNewSandbox({ gitUrl });
  }, []);

  const firstName = currentUser?.name?.split(' ')[0] || 'there';

  const openWorldView = (projection: WorldViewProjection) =>
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

        {/* Primary cards — WorldView projections + the token plan glance */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <button
            type="button"
            onClick={() => openWorldView(WorldViewProjection.WORLD)}
            data-testid="hub-home-world"
            className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-5 text-start transition-colors hover:bg-accent"
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
            className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-5 text-start transition-colors hover:bg-accent"
          >
            <Building2 className="h-6 w-6 text-muted-foreground group-hover:text-foreground" />
            <span className="text-base font-semibold">
              <Trans>Organization</Trans>
            </span>
            <span className="text-sm text-muted-foreground">
              <Trans>Teams and people across your org.</Trans>
            </span>
          </button>

          <TokenPlanCard />
        </div>

        {/* Projects — real hub data (graph/project). Always rendered, zero
            projects included: the hub has projects and a current project like
            the desktop does, so "get me into a project" must be reachable from
            an empty hub home too. The actions are project home's tiles, one
            shared component with the Vibe hero (see ProjectActionsRow). */}
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            <Trans>Projects</Trans>
          </h2>
          <ProjectActionsRow variant="tiles" />
          {!!projects?.length && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {/* The card is a div wrapping the open button, not a button
                  itself: the delete control lives inside it, and a button
                  nested in a button is invalid and eats its own clicks. Same
                  shape the sandbox cards below already use. */}
              {projects.map((p) => {
                const isCurrent = currentProject?.id === p.id;
                const deleting = deletingProjectId === p.id;
                return (
                  <div
                    key={p.id}
                    data-testid="hub-project-card"
                    className={`group flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors hover:bg-accent ${
                      isCurrent ? 'border-primary bg-primary/5' : 'border-border bg-card'
                    }`}
                  >
                    <FolderGit2
                      className={`h-4 w-4 shrink-0 ${isCurrent ? 'text-primary' : 'text-muted-foreground'}`}
                    />
                    <button
                      type="button"
                      aria-pressed={isCurrent}
                      // Clicking opens the project dock, which sets CurrentProject
                      // context — the same navigation the footer's name button uses,
                      // so the footer follows the click. URL-first: only openDock.
                      onClick={() => navigation.openDock(DockPointer.forProject(p.id).withPage(PageId.HUB))}
                      className="min-w-0 flex-1 truncate text-start text-sm"
                      title={p.displayName}
                    >
                      {p.displayName || t`Untitled project`}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteProject(p)}
                      disabled={deleting}
                      aria-label={t`Delete project`}
                      data-testid="hub-project-delete"
                      className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-50 group-hover:opacity-100"
                    >
                      {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Pending invitations.
            Lives here because the hub page has no Inbox: `renderHubBody`
            (content-panel.tsx) has no ViewType.INBOX case, so `InboxView` — and
            with it the usual home for `MembershipInvitations` — never renders
            under page=hub. Without this the rows are fetchable and have nowhere
            to appear. Above Sandboxes deliberately: a sandbox share is the
            invitation this page will mostly receive, and accepting one changes
            the list directly below it. Renders nothing when there are none. */}
        <MembershipInvitations recipientEmail={currentUser?.email ?? null} onPendingCount={setPendingInviteCount} />
        {pendingInviteCount > 0 && (
          <p className="-mt-2 text-xs text-muted-foreground">
            <Trans>Accepting adds it to your Sandboxes below.</Trans>
          </p>
        )}

        {/* Sandboxes — cloud FlowPad instances running in E2B (ComputeNode flavor=workspace) */}
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            <Trans>Sandboxes</Trans>
          </h2>
          {/* New sandbox — same DesktopTile shape the Projects section uses. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <DesktopTile
                Icon={Monitor}
                label={creating ? t`Creating…` : t`New Sandbox`}
                loading={creating}
                disabled={!canCreateSandbox}
                onClick={() => setNewSandbox({})}
                data-testid="new-sandbox-button"
              />
            </TooltipTrigger>
            {!canCreateSandbox && (
              <TooltipContent>
                {!sandboxesEnabled ? <Trans>Sandbox unavailable</Trans> : <Trans>Sign in to create sandboxes</Trans>}
              </TooltipContent>
            )}
          </Tooltip>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sandboxes.map((d) => (
              <div
                key={d.id}
                data-testid="sandbox-card"
                data-node-id={d.id}
                data-provider-id={d.node_provider_id}
                data-status={details[d.id]?.status}
                title={sandboxesEnabled ? undefined : t`Sandbox unavailable`}
                className={`group flex flex-col gap-1.5 rounded-lg border bg-card px-4 py-3 transition-colors ${statusCardClass(
                  details[d.id]?.status,
                )} ${sandboxesEnabled ? '' : 'opacity-60'}`}
              >
                <div className="flex items-center gap-3">
                  <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {editingId === d.id ? (
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onBlur={() => {
                        void renameSandbox(d, draftName);
                        setEditingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                        else if (e.key === 'Escape') setEditingId(null);
                      }}
                      data-testid="sandbox-name-input"
                      className="min-w-0 flex-1 border-b border-border bg-transparent text-sm outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setDraftName(d.name || '');
                        setEditingId(d.id);
                      }}
                      disabled={!sandboxesEnabled}
                      className="min-w-0 flex-1 truncate text-start text-sm hover:underline disabled:pointer-events-none"
                      title={sandboxesEnabled ? t`Click to rename` : undefined}
                      data-testid="sandbox-name"
                    >
                      {d.name || t`Sandbox`}
                    </button>
                  )}
                  {/* A labelled button, and visible WITHOUT hovering.
                      Opening is the one thing you come to this card to do, and
                      as a hover-only icon it was both undiscoverable and
                      indistinguishable from the share/secrets/delete icons
                      beside it. Those stay as hover icons — they are the rarer,
                      more destructive actions. */}
                  {/* Two different acts behind one slot. A box that was never
                      launched has no VM to open — the hub answers "this machine
                      has not been set up yet" — so offering "Open" would be a
                      button that 409s. Launch asks first; Open does not. */}
                  {isLaunched(d) ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => openSandbox(d)}
                      disabled={!sandboxesEnabled}
                      aria-label={t`Open sandbox`}
                      data-testid="sandbox-open"
                      className="h-7 shrink-0 px-2.5 text-xs"
                    >
                      <Trans>Open</Trans>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => setLaunching(d)}
                      disabled={!sandboxesEnabled || launchingId === d.id}
                      aria-label={t`Launch sandbox`}
                      data-testid="sandbox-launch"
                      className="h-7 shrink-0 px-2.5 text-xs"
                    >
                      {launchingId === d.id && <Loader2 className="me-1.5 h-3 w-3 animate-spin" />}
                      <Trans>Launch</Trans>
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => setSharing(d)}
                    disabled={!sandboxesEnabled || !currentUser}
                    aria-label={t`Share sandbox`}
                    data-testid="sandbox-share"
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground disabled:pointer-events-none disabled:opacity-50 group-hover:opacity-100"
                  >
                    <UserPlus className="h-4 w-4" />
                  </button>
                  {/* Sign THIS box out — shown only when the box is running the
                      session of the person looking at the page.

                      The condition is the point. A box holds one cloud session,
                      so "log out" is only ever meaningful about that one user;
                      offering it while the box is signed in as someone else
                      would read as a way to evict them, which this is not (it
                      would also 403 — `ops` is owner-only). Comparison is on the
                      normalized email because `logged_in_user` is whatever the
                      box's provider record carried.

                      This does NOT sign the viewer out of the hub page: the
                      credentials being cleared live on the box's disk. */}
                  {isSignedInAsMe(d, currentUser?.email) && (
                    <button
                      type="button"
                      onClick={() => void logoutSandbox(d)}
                      disabled={loggingOutId === d.id || !sandboxesEnabled}
                      aria-label={t`Sign this sandbox out`}
                      title={t`Sign out of this sandbox (you stay signed in here)`}
                      data-testid="sandbox-logout"
                      className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground disabled:pointer-events-none disabled:opacity-50 group-hover:opacity-100"
                    >
                      {loggingOutId === d.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <LogOut className="h-4 w-4" />
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={openSandboxSecrets}
                    disabled={!sandboxesEnabled}
                    aria-label={t`Machine secrets`}
                    data-testid="sandbox-secrets"
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                  >
                    <KeyRound className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteSandbox(d)}
                    disabled={deletingId === d.id || !sandboxesEnabled}
                    aria-label={t`Delete sandbox`}
                    data-testid="sandbox-delete"
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive disabled:pointer-events-none disabled:opacity-50 group-hover:opacity-100"
                  >
                    {deletingId === d.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <SandboxStatus
                  info={details[d.id]}
                  now={now}
                  launched={isLaunched(d)}
                  launching={launchingId === d.id}
                  loggedInUser={d.logged_in_user}
                  autoLogin={d.auto_login}
                />
              </div>
            ))}
          </div>

          {/* Progress used to render HERE, behind a dialog that had already
              closed. It now lives inside NewSandboxDialog, which stays open for
              the whole create — so there is nothing left to show on the page. */}
        </div>
      </div>

      {/* New-sandbox modal: name + optional git repo (with the connect-GitHub gate). */}
      <NewSandboxDialog
        open={!!newSandbox}
        onOpenChange={(o) => {
          if (!o) setNewSandbox(null);
        }}
        defaultName={nextSandboxName(sandboxes)}
        initialGitUrl={newSandbox?.gitUrl}
        // The sandbox opens on the project you're working on unless you change
        // it — same source the footer's StatusBar reads.
        currentProject={currentProject}
        projects={projects}
        onCreate={createSandbox}
        onLaunch={launchSandbox}
        onOpen={openSandbox}
        steps={steps}
      />

      {/* First boot of a box created earlier — the click that starts costing
          money, and the last moment auto-login can be chosen. */}
      <LaunchSandboxDialog
        open={!!launching}
        onOpenChange={(o) => {
          if (!o) setLaunching(null);
        }}
        sandbox={launching}
        onLaunch={launchSandbox}
        onOpen={openSandbox}
        steps={steps}
      />

      {/* Share / hand over a sandbox. `isOwner` is a UI courtesy only — the hub
          gates both the invite and the auto-login action on ownership. */}
      <ShareSandboxDialog
        open={!!sharing}
        onOpenChange={(o) => {
          if (!o) setSharing(null);
        }}
        sandbox={sharing}
        isOwner={!!sharing}
        currentUserId={currentUser?.id}
        currentUserEmail={currentUser?.email}
        onShared={() => void refetch()}
        // Sharing a box that was never launched hands out a link the recipient
        // cannot act on, so the confirm offers the fix: the SAME dialog the card's
        // Launch button opens, with its checklist and its auto-login choice.
        // Only opens the launcher — the share dialog closes itself, as it does on
        // every other exit.
        onLaunchInstead={() => setLaunching(sharing)}
      />

      {/* Deleting a project is not undoable and it is shared — the people it was
          shared with lose it too — so it asks first, unlike the sandbox rows. */}
      <ConfirmDialog
        open={!!confirmDeleteProject}
        onOpenChange={(o) => {
          if (!o) setConfirmDeleteProject(null);
        }}
        title={t`Delete project?`}
        description={t`"${confirmDeleteProject?.displayName ?? ''}" will be deleted for everyone it is shared with. This cannot be undone.`}
        confirmLabel={t`Delete`}
        variant="destructive"
        onConfirm={() => {
          const project = confirmDeleteProject;
          setConfirmDeleteProject(null);
          if (project) void deleteProject(project);
        }}
      />
    </div>
  );
}

export default HubHome;

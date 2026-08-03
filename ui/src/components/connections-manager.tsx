import {
  ConnectionStatus,
  TypeId,
  type OAuthConnection,
  type OAuthDetachResult,
  type OAuthFlowKind,
  type OAuthTestResult,
  type Project,
} from '@sdk';
import { Check, CircleHelp, Loader2, MoreHorizontal, Trash2, X } from 'lucide-react';
import * as React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useOAuthConnection } from '@sdk/react/hooks/useOAuthConnection';
// The grant/placement split lives with the hook that derives it; the SDK root
// does not re-export react-only modules.
import { GrantStatus } from '@sdk/react/hooks';
import { cn } from '@src/lib/utils';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';
import { isLucideName } from '@src/lib/icon-value';
import { lucideByName } from '@src/lib/lucide-by-name';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { Badge } from './ui/badge';
import { providerMark } from './connections-manager/provider-marks';
import { useConnectionTimestamps } from './connections-manager/use-connection-timestamps';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { UsageCell } from './connections-manager/usage-cell';
import { USAGE_EAGER_LIMIT, useCredentialUsage } from './connections-manager/use-credential-usage';
import { useProjects } from '@src/hooks/use-projects';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

export interface ConnectionsManagerProps {
  /**
   * The project an OAuth token attaches to. Connect and disconnect are
   * disabled without one — a token has to be granted TO something.
   */
  projectTypeId?: TypeId;
  className?: string;
  /** Render the "OAuth Connections" heading. */
  header?: boolean;
  onConnectionConnect?: (connectionId: string) => void;
  onConnectionDisconnect?: (connectionId: string, detachResult?: OAuthDetachResult) => void;
}

// Extended OAuth connection type that includes providerName for internal use
interface ExtendedOAuthConnection extends OAuthConnection {
  providerName: string;
  kind?: OAuthFlowKind;
  scopes?: string[];
  icon?: string;
}

/** The Status column answers ONE question: is my account connected to this
 *  provider? That is the grant, and it is the only thing that means anything
 *  when no project is selected. Which projects may USE the credential is a
 *  different question, answered by the Used-by column — conflating the two is
 *  how a held credential used to render as the baffling "Ready to connect",
 *  which reads like "not connected" to everyone who isn't holding the data
 *  model in their head. */
const GRANT_META: Record<GrantStatus, { dot: string; text: string }> = {
  [GrantStatus.NONE]: { dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
  [GrantStatus.HELD]: { dot: 'bg-green-500', text: 'text-green-600 dark:text-green-500' },
  // Held but dead. Red rather than amber: amber would say "one click from
  // working", and this needs the whole grant again.
  [GrantStatus.NEEDS_REAUTH]: { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-500' },
};

/** How many scopes to show before collapsing the rest into a count. A dozen
 *  chips would bury the row it belongs to. */
const SCOPES_SHOWN = 4;

/** Stable fallback for a provider with no placements. */
const NO_PROJECTS: Project[] = [];

/** The provider glyph.
 *
 *  `icon` arrives in two unrelated shapes: a lucide export name from the local
 *  registry ("Github", "Sparkles") and a path from the hub
 *  ("public/github-icon.svg"). Everything used to go into `<img src>`, so the
 *  lucide names 404'd and `onError` hid them — which is why no provider had an
 *  icon at all. A monogram is the last resort so the column is never empty. */
/** The last probe's verdict, as a dot.
 *
 *  Three states, because `ok` has three: passed, rejected, and never asked. The
 *  third must not look like the first — a tick for "no test exists" would be a
 *  claim the code cannot back. Absent until a test has run. */
const ProbeVerdict: React.FC<{ result?: OAuthTestResult }> = ({ result }) => {
  if (!result) return null;
  if (result.ok === true) return <Check className="h-3 w-3 text-green-600 dark:text-green-500" />;
  if (result.ok === false) return <X className="h-3 w-3 text-destructive" />;
  return <CircleHelp className="h-3 w-3 text-muted-foreground/70" />;
};

/** The remote-icon case, isolated so its failure state lives where it is used
 *  and a changed `icon` remounts it via `key` instead of an effect that resets. */
const ProviderImage: React.FC<{ src: string; fallback: React.ReactNode }> = ({ src, fallback }) => {
  const [failed, setFailed] = React.useState(false);
  if (failed) return <>{fallback}</>;
  return <img src={src} alt="" className="h-4 w-4 shrink-0 rounded-sm" onError={() => setFailed(true)} />;
};

const ProviderGlyph: React.FC<{ icon?: string; name: string; providerName: string }> = ({
  icon,
  name,
  providerName,
}) => {
  const monogram = (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm bg-muted text-[10px] font-semibold uppercase text-muted-foreground">
      {name.slice(0, 1)}
    </span>
  );

  // Slack only — see provider-marks. Everything else comes from the backend's
  // published icon name.
  const Mark = providerMark(providerName);
  if (Mark) return <Mark className="h-4 w-4 shrink-0" />;

  // `isLucideName` checks the real export table; guessing from punctuation would
  // misfile any name containing a dot.
  if (icon && isLucideName(icon)) {
    const Icon = lucideByName(icon);
    return <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  // The hub's paths are relative to ITS static root, so many 404 here — fall
  // through to the monogram rather than leaving the cell empty, which would read
  // as "this provider has no icon".
  if (icon) return <ProviderImage key={icon} src={icon} fallback={monogram} />;
  return monogram;
};

export const ConnectionsManager: React.FC<ConnectionsManagerProps> = ({
  projectTypeId,
  className,
  header = true,
  onConnectionConnect,
  onConnectionDisconnect,
}) => {
  const { t } = useLingui();
  const { timestamps: connectionTimestamps, record, forget } = useConnectionTimestamps();

  // Handle OAuth authentication success (auth completed, auto-attached)
  const handleOAuthAuthSuccess = React.useCallback(
    (connectionId: string) => {
      onConnectionConnect?.(connectionId);
    },
    [onConnectionConnect],
  );

  // Handle OAuth attach success (connection is now fully connected)
  const handleOAuthAttachSuccess = React.useCallback(
    (connectionId: string) => {
      record(connectionId);
      onConnectionConnect?.(connectionId);
    },
    [onConnectionConnect, record],
  );

  // Handle OAuth connection disconnect
  const handleOAuthDisconnect = React.useCallback(
    (connectionId: string, detachResult?: OAuthDetachResult) => {
      forget(connectionId);
      onConnectionDisconnect?.(connectionId, detachResult);
    },
    [onConnectionDisconnect, forget],
  );

  const {
    connectingConnectionId,
    availableProviders,
    connectionStatuses: providerStatuses,
    grantStatuses,
    userTable,
    connect,
    attach,
    detach,
    disconnect,
    testConnection,
  } = useOAuthConnection({
    projectTypeId,
    onConnectionDisconnect: handleOAuthDisconnect,
    onOAuthAuthSuccess: handleOAuthAuthSuccess, // OAuth auth completed (status: AVAILABLE)
    onAttachSuccess: handleOAuthAttachSuccess, // Attach completed (status: CONNECTED)
  });

  // Create connections from available providers with their statuses
  const allConnections: ExtendedOAuthConnection[] = React.useMemo(() => {
    return availableProviders.map((provider) => ({
      id: provider.name.toLowerCase(),
      provider: provider.display_name,
      providerName: provider.name, // Keep the actual provider name for API calls
      status: providerStatuses[provider.name] || ConnectionStatus.DISCONNECTED,
      connectedAt: connectionTimestamps[provider.name.toLowerCase()],
      kind: provider.kind,
      scopes: provider.scopes,
      icon: provider.icon,
    }));
  }, [availableProviders, providerStatuses, connectionTimestamps]);

  // "Where is this used?" — one env-table fetch per project, answering for every
  // row at once. Gated above a threshold so a large workspace doesn't fan out on
  // arrival; the delete dialog force-enables it, because blast radius must never
  // be guessed.
  const { projects } = useProjects();
  const [usageForced, setUsageForced] = React.useState(false);
  const usageEnabled = usageForced || (projects?.length ?? 0) <= USAGE_EAGER_LIMIT;
  const { usage, isLoading: usageLoading } = useCredentialUsage({ projects, userTable, enabled: usageEnabled });
  // Which project row inside a usage popover is mid-attach/detach.
  const [togglingProjectId, setTogglingProjectId] = React.useState<string | null>(null);
  // The connection awaiting a delete confirmation (null = dialog closed).
  const [pendingDelete, setPendingDelete] = React.useState<ExtendedOAuthConnection | null>(null);
  // Constant for the whole render, and a stable empty array so the usage cell's
  // memo isn't invalidated by a fresh `[]` on every row of every render.
  const hubOnly = isHubOnly();

  // Last probe result per connection. Deliberately NOT persisted: it is a
  // point-in-time answer about a token that can be revoked a second later, and a
  // remembered tick would outlive its truth.
  const [testResults, setTestResults] = React.useState<Record<string, OAuthTestResult>>({});
  // Which rows have a test in flight. A set, not a map: the question is
  // membership, and more than one row can be testing at once (each row's button
  // disables only itself).
  const [testing, setTesting] = React.useState<ReadonlySet<string>>(new Set());

  // Labels live here, not in a module-level lookup table: a raw string in a
  // Record escapes lingui extraction entirely, so the redesign had quietly made
  // every status and grant name untranslatable.
  const statusLabel = (grant: GrantStatus): string =>
    grant === GrantStatus.HELD
      ? t`Connected`
      : grant === GrantStatus.NEEDS_REAUTH
        ? t`Reconnect needed`
        : t`Not connected`;

  const grantLabel = (kind: OAuthFlowKind): string =>
    kind === 'device' ? t`Device code` : kind === 'loopback' ? t`OAuth + PKCE` : t`OAuth`;

  const grantHint = (kind: OAuthFlowKind): string =>
    kind === 'device'
      ? t`You type a short code into the provider's site`
      : kind === 'loopback'
        ? t`Authorization code with PKCE, redirected back to this machine`
        : t`Authorization code — you approve in the browser and come back`;

  const handleTest = async (connection: ExtendedOAuthConnection) => {
    setTesting((prev) => new Set(prev).add(connection.id));
    try {
      const result = await testConnection(connection.providerName);
      setTestResults((prev) => ({ ...prev, [connection.id]: result }));
      if (result.ok === true) {
        notify.success({
          title: t`${connection.provider} is working`,
          message: result.identity ? t`Authenticated as ${result.identity}` : t`The provider accepted the token.`,
        });
      } else if (result.ok === false) {
        notify.error({
          title: t`${connection.provider} test failed`,
          message: result.detail || t`The provider rejected the stored token.`,
        });
      } else {
        // Not a pass and not a failure — say which.
        notify.info({
          title: t`${connection.provider} not tested`,
          message: result.detail || t`No connection test is defined for this provider.`,
        });
      }
    } catch (error) {
      setTestResults((prev) => ({ ...prev, [connection.id]: { ok: null, detail: 'error' } }));
      notify.error({
        title: t`${connection.provider} test failed`,
        message: errorMessage(error, t`Could not run the connection test.`),
      });
    } finally {
      setTesting((prev) => {
        const next = new Set(prev);
        next.delete(connection.id);
        return next;
      });
    }
  };

  /** Grant — run the OAuth flow. Attaches the selected project on the way when
   *  there is one; with none, it is a user-level grant and nothing more.
   *
   *  This used to refuse outright without a project ("an OAuth token is granted
   *  to a project, not to the app"), which is only half true: the grant is
   *  user-scoped on BOTH backends — neither `auth` handler reads a target
   *  entity — and only the attach that follows needs a project. On the hub,
   *  where a user can hold zero projects, that guard made every row a dead end. */
  const handleConnect = async (connectionId: string) => {
    const connection = allConnections.find((conn) => conn.id === connectionId);
    if (!connection) return;

    try {
      const providerName = connection.providerName;
      await connect(connectionId, providerName);
    } catch (error) {
      // Surfaced, not just logged: every failure here (a provider this instance
      // cannot complete a flow for, a backend refusal) used to land in the
      // console only, so the button looked like it did nothing.
      notify.error({
        title: t`${connection.provider} connection failed`,
        message: errorMessage(error, t`Could not connect to ${connection.provider}.`),
      });
    }
  };

  /** Placement — give the selected project use of a credential already held. */
  const handleAttach = async (connectionId: string) => {
    const connection = allConnections.find((conn) => conn.id === connectionId);
    if (!connection || !projectTypeId) return;
    try {
      await attach(connectionId, connection.providerName);
    } catch (error) {
      notify.error({
        title: t`${connection.provider} connection failed`,
        message: errorMessage(error, t`Could not give this project access to ${connection.provider}.`),
      });
    }
  };

  /** Attach/detach a project named by the usage popover — which is usually NOT
   *  the selected one; that is the point of managing placement from there. */
  const handleToggleProject = async (connection: ExtendedOAuthConnection, project: Project, nextAttached: boolean) => {
    const providerName = connection.providerName;
    setTogglingProjectId(project.id ?? null);
    try {
      if (nextAttached) {
        await attach(connection.id, providerName, undefined, project.typeId);
      } else {
        await detach(connection.id, providerName, project.typeId);
      }
    } catch (error) {
      notify.error({
        title: nextAttached ? t`Could not give access` : t`Could not remove access`,
        message: errorMessage(error, t`${connection.provider} could not be updated for this project.`),
      });
    } finally {
      setTogglingProjectId(null);
    }
  };

  /** What the confirmation says. Names the projects rather than counting them:
   *  "3 projects" is a number, "Alpha, Beta and Gamma" is a decision. */
  const deleteDescription = (connection: ExtendedOAuthConnection | null): string => {
    if (!connection) return '';
    const names = (usage[connection.providerName] ?? []).map((p) => p.displayName || p.name).filter(Boolean);
    const provider = connection.provider;
    if (names.length === 0) {
      return t`The credential is removed from your account. No project is using it right now, and you'll have to sign in again to use ${provider}.`;
    }
    const list = names.join(', ');
    return t`${provider} is used by ${names.length} project(s): ${list}. Deleting removes access for all of them, and you'll have to sign in again.`;
  };

  /** Destroy the user's credential. Distinct from detach in kind, not degree —
   *  every project that borrowed it loses access — so it is always confirmed. */
  const handleDeleteCredential = async (connection: ExtendedOAuthConnection) => {
    const providerName = connection.providerName;
    try {
      await disconnect(connection.id, providerName);
      notify.success({
        title: t`${connection.provider} deleted`,
        message: t`The credential was removed from your account.`,
      });
    } catch (error) {
      notify.error({
        title: t`Could not delete ${connection.provider}`,
        message: errorMessage(error, t`The credential could not be removed.`),
      });
    }
  };

  const handleDisconnect = async (connectionId: string) => {
    const connection = allConnections.find((conn) => conn.id === connectionId);
    if (!connection) return;

    try {
      const providerName = connection.providerName;
      // Status 3: Detach from current project
      await detach(connectionId, providerName);
    } catch (error) {
      notify.error({
        title: t`${connection.provider} disconnect failed`,
        message: errorMessage(error, t`Could not disconnect from ${connection.provider}.`),
      });
    }
  };

  return (
    // No frame of its own — the host supplies height and padding.
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="connections-manager">
      <div className="mb-4">
        {header && (
          <h2 className="text-xl font-semibold">
            <Trans>OAuth Connections</Trans>
          </h2>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {/* Capped: the columns are all short, so a full-width dock strands the
            status and the button metres away from the provider they belong to. */}
        <Table className="max-w-5xl">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[180px]">
                <Trans>Provider</Trans>
              </TableHead>
              <TableHead className="w-[130px]">
                <Trans>Sign-in</Trans>
              </TableHead>
              <TableHead>
                <Trans>Access requested</Trans>
              </TableHead>
              <TableHead className="w-[200px]">
                <Trans>Status</Trans>
              </TableHead>
              <TableHead className="w-[180px]">
                <Trans>Used by</Trans>
              </TableHead>
              <TableHead className="w-[210px] text-right">
                <Trans>Actions</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allConnections.map((connection) => {
              // Grant vs placement: `grant` says whether the user holds the
              // credential at all (answerable with no project); `status` says
              // what the selected project sees.
              const grant = grantStatuses[connection.providerName] ?? GrantStatus.NONE;
              const held = grant !== GrantStatus.NONE;
              const attachedProjects = usage[connection.providerName] ?? NO_PROJECTS;
              return (
                <TableRow key={connection.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <ProviderGlyph
                        icon={connection.icon}
                        name={connection.provider}
                        providerName={connection.providerName}
                      />
                      <span className="truncate">{connection.provider}</span>
                    </div>
                  </TableCell>

                  <TableCell data-testid={`connection-kind-${connection.id}`}>
                    {connection.kind ? (
                      <Badge
                        variant="outline"
                        className="cursor-default rounded-full px-2 text-[11px] font-medium text-muted-foreground"
                        title={grantHint(connection.kind)}
                      >
                        {grantLabel(connection.kind)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground/60">—</span>
                    )}
                  </TableCell>

                  <TableCell data-testid={`connection-scopes-${connection.id}`}>
                    {connection.scopes?.length ? (
                      <div className="flex flex-wrap items-center gap-1">
                        {connection.scopes.slice(0, SCOPES_SHOWN).map((scope) => (
                          <Badge
                            key={scope}
                            variant="secondary"
                            className="rounded px-1.5 py-px font-mono text-[11px] font-normal text-muted-foreground"
                          >
                            {scope}
                          </Badge>
                        ))}
                        {connection.scopes.length > SCOPES_SHOWN && (
                          <span className="text-[11px] text-muted-foreground/70" title={connection.scopes.join(', ')}>
                            +{connection.scopes.length - SCOPES_SHOWN}
                          </span>
                        )}
                      </div>
                    ) : (
                      // Not "no scopes" — the side that owns the flow did not
                      // publish them. Saying "none" would be a lie.
                      <span className="text-xs text-muted-foreground/60">
                        <Trans>Shown at approval</Trans>
                      </span>
                    )}
                  </TableCell>

                  <TableCell>
                    {(() => {
                      const meta = GRANT_META[grant];
                      const connecting = connectingConnectionId === connection.id;
                      return (
                        <div className="flex items-center gap-2 text-sm">
                          <span
                            className={cn(
                              'h-2 w-2 shrink-0 rounded-full',
                              connecting ? 'animate-pulse bg-primary' : meta.dot,
                            )}
                          />
                          <span className={connecting ? 'text-muted-foreground' : meta.text}>
                            {connecting ? t`Waiting for approval…` : statusLabel(grant)}
                          </span>
                          {!connecting && connection.connectedAt && (
                            <span className="truncate text-xs text-muted-foreground/70">
                              {formatTimeAgo(connection.connectedAt.toISOString())}
                            </span>
                          )}
                        </div>
                      );
                    })()}
                  </TableCell>

                  <TableCell data-testid={`connection-usage-${connection.id}`}>
                    {held ? (
                      <UsageCell
                        projects={projects ?? []}
                        attached={attachedProjects}
                        isLoading={usageLoading}
                        isEnabled={usageEnabled}
                        onEnable={() => setUsageForced(true)}
                        busyProjectId={togglingProjectId}
                        onToggle={(project, next) => void handleToggleProject(connection, project, next)}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground/60">—</span>
                    )}
                  </TableCell>

                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* A probe spends the token, so it runs as whoever is
                          allowed to spend it. The hub REFUSES a test with no
                          target entity ("a test must not become a way to
                          exercise a credential the caller was never granted"),
                          and `testConnection` sends the selected project as that
                          target — so on a hub the button needs one. The
                          desktop's probe is user-scoped and needs nothing.
                          Offer it exactly where it can succeed. */}
                      {held && (!hubOnly || Boolean(projectTypeId)) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleTest(connection)}
                          disabled={testing.has(connection.id)}
                          className="h-7 gap-1.5 text-muted-foreground hover:text-foreground"
                          data-testid={`connection-test-${connection.id}`}
                          title={t`Call ${connection.provider} with the stored token`}
                        >
                          {testing.has(connection.id) ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <ProbeVerdict result={testResults[connection.id]} />
                          )}
                          <Trans>Test</Trans>
                        </Button>
                      )}
                      {/* Placement, scoped to the selected project. Cheap and
                          reversible from the same row, so no confirmation. */}
                      {held && projectTypeId && connection.status === ConnectionStatus.CONNECTED && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleDisconnect(connection.id)}
                          disabled={connectingConnectionId === connection.id}
                          className="h-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          data-testid={`connection-detach-${connection.id}`}
                        >
                          <Trans>Remove from project</Trans>
                        </Button>
                      )}
                      {held && projectTypeId && connection.status === ConnectionStatus.AVAILABLE && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleAttach(connection.id)}
                          disabled={connectingConnectionId === connection.id}
                          className="h-7"
                          data-testid={`connection-attach-${connection.id}`}
                        >
                          <Trans>Add to project</Trans>
                        </Button>
                      )}
                      {/* The grant itself. Offered when there is no usable
                          credential — including NEEDS_REAUTH, where attaching
                          would re-share a refused token and report success. */}
                      {grant !== GrantStatus.HELD && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleConnect(connection.id)}
                          disabled={connectingConnectionId === connection.id}
                          className="h-7"
                        >
                          {connectingConnectionId === connection.id ? (
                            <>
                              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                              <Trans>Connecting</Trans>
                            </>
                          ) : grant === GrantStatus.NEEDS_REAUTH ? (
                            <Trans>Reconnect</Trans>
                          ) : (
                            <Trans>Connect</Trans>
                          )}
                        </Button>
                      )}
                      {/* Destroying the credential is a different act from
                          detaching, so it lives behind an overflow menu and a
                          confirmation rather than next to the everyday buttons. */}
                      {held && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                              title={t`More`}
                              data-testid={`connection-more-${connection.id}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => {
                                // Force the usage fan-out: the dialog must name
                                // what breaks, and "unknown" is not an option.
                                setUsageForced(true);
                                setPendingDelete(connection);
                              }}
                              data-testid={`connection-delete-${connection.id}`}
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" />
                              <Trans>Delete credential</Trans>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {allConnections.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                  <Trans>No OAuth providers available</Trans>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Blast radius, by name. The count comes from the same usage map the
          Used-by column reads, force-loaded when this dialog opens. */}
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null);
            setUsageForced(false);
          }
        }}
        title={t`Delete ${pendingDelete?.provider ?? ''} credential?`}
        description={deleteDescription(pendingDelete)}
        confirmLabel={t`Delete credential`}
        variant="destructive"
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void handleDeleteCredential(target);
        }}
        onCancel={() => {
          setPendingDelete(null);
          setUsageForced(false);
        }}
      />
    </div>
  );
};

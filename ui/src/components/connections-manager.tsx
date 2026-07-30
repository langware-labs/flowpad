import {
  ConnectionStatus,
  TypeId,
  type OAuthConnection,
  type OAuthDetachResult,
  type OAuthFlowKind,
  type OAuthTestResult,
} from '@sdk';
import { Check, CircleHelp, Loader2, X } from 'lucide-react';
import * as React from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useOAuthConnection } from '@sdk/react/hooks/useOAuthConnection';
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



/** The three states, each visually distinct.
 *
 *  They used to share one grey circle and one grey label, so "Ready to Connect"
 *  and "Disconnected" were indistinguishable — the only difference that matters
 *  here, since one needs a browser round-trip and the other does not. Theme
 *  tokens rather than `gray-500`, which does not survive dark mode. */
const STATUS_META: Record<ConnectionStatus, { dot: string; text: string }> = {
  [ConnectionStatus.CONNECTED]: { dot: 'bg-green-500', text: 'text-green-600 dark:text-green-500' },
  [ConnectionStatus.AVAILABLE]: { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-500' },
  [ConnectionStatus.DISCONNECTED]: { dot: 'bg-muted-foreground/40', text: 'text-muted-foreground' },
};

/** How many scopes to show before collapsing the rest into a count. A dozen
 *  chips would bury the row it belongs to. */
const SCOPES_SHOWN = 4;

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
    connect,
    attach,
    detach,
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
  const statusLabel = (status: ConnectionStatus): string =>
    status === ConnectionStatus.CONNECTED
      ? t`Connected`
      : status === ConnectionStatus.AVAILABLE
        ? t`Ready to connect`
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

  const handleConnect = async (connectionId: string) => {
    const connection = allConnections.find((conn) => conn.id === connectionId);
    if (!connection) return;
    // Check if we have a current project
    if (!projectTypeId) {
      notify.error({
        title: t`No project selected`,
        message: t`Pick a project first — an OAuth token is granted to a project, not to the app.`,
      });
      return;
    }

    try {
      const currentStatus = connection.status;
      const providerName = connection.providerName || connection.provider.toLowerCase();

      if (currentStatus === ConnectionStatus.DISCONNECTED) {
        // No OAuth token exists, start full OAuth flow
        await connect(connectionId, providerName);
      } else {
        // OAuth token exists (AVAILABLE/CONNECTED), just attach to current project
        await attach(connectionId, providerName);
      }
    } catch (error) {
      // Surfaced, not just logged: every failure here (no token yet, a provider
      // this instance cannot complete a flow for, a backend refusal) used to
      // land in the console only, so the button looked like it did nothing.
      notify.error({
        title: t`${connection.provider} connection failed`,
        message: errorMessage(error, t`Could not connect to ${connection.provider}.`),
      });
    }
  };

  const handleDisconnect = async (connectionId: string) => {
    const connection = allConnections.find((conn) => conn.id === connectionId);
    if (!connection) return;

    try {
      const providerName = connection.providerName || connection.provider.toLowerCase();
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
              <TableHead className="w-[180px]"><Trans>Provider</Trans></TableHead>
              <TableHead className="w-[130px]"><Trans>Sign-in</Trans></TableHead>
              <TableHead><Trans>Access requested</Trans></TableHead>
              <TableHead className="w-[200px]"><Trans>Status</Trans></TableHead>
              <TableHead className="w-[210px] text-right"><Trans>Actions</Trans></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {allConnections.map((connection) => {
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
                          <span
                            className="text-[11px] text-muted-foreground/70"
                            title={connection.scopes.join(', ')}
                          >
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
                      const meta = STATUS_META[connection.status] ?? STATUS_META[ConnectionStatus.DISCONNECTED];
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
                            {connecting ? t`Waiting for approval…` : statusLabel(connection.status)}
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

                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      {connection.status !== ConnectionStatus.DISCONNECTED && (
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
                      {connection.status === ConnectionStatus.CONNECTED ? (
                      // Ghost until hovered, and destructive only then: revoking
                      // access should not be the loudest thing in a table whose
                      // normal state is "already connected".
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleDisconnect(connection.id)}
                        disabled={connectingConnectionId === connection.id}
                        className="h-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trans>Disconnect</Trans>
                      </Button>
                    ) : (
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
                        ) : (
                          <Trans>Connect</Trans>
                        )}
                      </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {allConnections.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                  <Trans>No OAuth providers available</Trans>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
};

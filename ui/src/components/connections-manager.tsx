import {
  ConnectionKind,
  ConnectionStatus,
  type CredentialSpec,
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
import { MoreOnHover } from './connections-manager/more-on-hover';
import { providerMark } from './connections-manager/provider-marks';
import { useConnectionTimestamps } from './connections-manager/use-connection-timestamps';
import { Button } from './ui/button';
import { ConfirmDialog } from './ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { UsageCell } from './connections-manager/usage-cell';
import { USAGE_EAGER_LIMIT, useCredentialUsage } from './connections-manager/use-credential-usage';
import { useCredentialConnections } from './connections-manager/use-credential-connections';
import { CredentialConnectionRows } from './connections-manager/credential-rows-view';
import { FlowpadConnectionRow } from './connections-manager/flowpad-connection-row';
import { HarnessConnectionRows } from './connections-manager/harness-connection-rows';
import { useCheckHarnessLogins, useConnections } from '@src/hooks/use-connections';
import { openLlmSources } from './llm-sources/llm-sources-pointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import type { CredentialRow } from './credentials-view/credential-rows';
import {
  CredentialValueForm,
  EnvLocalBlockedNotice,
} from './connections-manager/credential-value-form';
import { AddConnectionDialog } from './connections-manager/add-connection-dialog';
import { Plus } from 'lucide-react';
import { useProjects } from '@src/hooks/use-projects';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

export interface ConnectionsManagerProps {
  /**
   * The project an OAuth token attaches to. Connect and disconnect are
   * disabled without one — a token has to be granted TO something.
   */
  projectTypeId?: TypeId;
  /**
   * The selected project, when the host already resolved it. Credential rows
   * are project-scoped (`SecretOrigin` identity is `(project_id, env_var)`) and
   * need the entity to call its two actions — and `useProjects()` is a
   * recency-limited list, so re-finding it by id here misses on an instance
   * with many projects.
   */
  project?: Project | null;
  className?: string;
  /** Render the "OAuth Connections" heading. */
  header?: boolean;
  onConnectionConnect?: (connectionId: string) => void;
  onConnectionDisconnect?: (connectionId: string, detachResult?: OAuthDetachResult) => void;
}

// Extended OAuth connection type that includes providerName for internal use
/**
 * How many columns the Connections table has — Provider · Sign-in · Access
 * requested · Status · Used by · Actions.
 *
 * Exported because several files render rows into this one `<TableBody>` and each
 * needs it for a full-width row. Deliberately not counting them here: a comment
 * that counts is a comment that goes stale the next time one is added.
 */
export const CONNECTIONS_COLUMN_COUNT = 6;

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
//: One chip plus a count, never a stack. Four chips wrapped a row to four lines
//: and pushed Status and Actions out of the viewport on a provider like Slack;
//: the full list is a hover away and was never scannable as chips anyway.
const SCOPES_SHOWN = 1;

/** The scopes cell: one chip, a count, and the rest a hover away.
 *
 *  The reveal itself is `MoreOnHover` — shared with the credential cell next
 *  door, which had the same dead `title` attribute.
 */
function ScopeChips({ scopes }: { scopes: string[] }) {
  const shown = scopes.slice(0, SCOPES_SHOWN);
  const hidden = scopes.length - shown.length;
  return (
    <MoreOnHover lines={scopes}>
      <div className="flex items-center gap-1">
        {shown.map((scope) => (
          <Badge
            key={scope}
            variant="secondary"
            className="max-w-[220px] truncate rounded px-1.5 py-px font-mono text-[11px] font-normal text-muted-foreground"
          >
            {scope}
          </Badge>
        ))}
        {!!hidden && (
          <span className="shrink-0 cursor-help text-[11px] text-muted-foreground/70 underline decoration-dotted underline-offset-2">
            +{hidden}
          </span>
        )}
      </div>
    </MoreOnHover>
  );
}

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

  // `isLucideName` now covers the bespoke brand marks too, which is what makes
  // Anthropic render its Claude logo instead of a monogram. Guessing from
  // punctuation would misfile any name containing a dot, so this goes through
  // the real tables.
  if (isLucideName(icon)) {
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
  project,
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

  // Create connections from available providers with their statuses.
  //
  // HELD ONLY. The table lists what exists; the dialog lists what you could add
  // (`addableProviders` below is the exact complement). Without this filter a
  // provider you have never connected is in both at once — a "Not connected"
  // row you cannot act on, and a tile offering to add the same thing.
  const allConnections: ExtendedOAuthConnection[] = React.useMemo(() => {
    return availableProviders
      .filter((provider) => (grantStatuses[provider.name] ?? GrantStatus.NONE) !== GrantStatus.NONE)
      .map((provider) => ({
        id: provider.name.toLowerCase(),
        provider: provider.display_name,
        providerName: provider.name, // Keep the actual provider name for API calls
        status: providerStatuses[provider.name] || ConnectionStatus.DISCONNECTED,
        connectedAt: connectionTimestamps[provider.name.toLowerCase()],
        kind: provider.kind,
        scopes: provider.scopes,
        icon: provider.icon,
      }));
  }, [availableProviders, providerStatuses, connectionTimestamps, grantStatuses]);

  // "Where is this used?" — one env-table fetch per project, answering for every
  // row at once. Gated above a threshold so a large workspace doesn't fan out on
  // arrival; the delete dialog force-enables it, because blast radius must never
  // be guessed.
  /**
   * The harness logins, from the ONE consolidated `connections` read.
   *
   * The rows used to resolve themselves, which cost a funding read plus a probe
   * per harness — five requests — and, worse, kept a second definition of
   * "signed in" in the browser. Only the harness rows are taken from this list
   * so far: the credential rows below need member-level state (declared,
   * adoptable, which line of `.env.local`) that a `ConnectionSpec` does not
   * carry, and the OAuth rows need the grant-vs-placement split that its single
   * `state` field collapses.
   */
  const { connections: consolidated } = useConnections(projectTypeId);
  // This screen is where a person comes to find out whether they are signed in,
  // so it is the screen that asks. The rows read "Not checked" until something
  // does.
  useCheckHarnessLogins();
  const harnessRows = React.useMemo(
    () => (consolidated ?? []).filter((row) => row.kind === ConnectionKind.Harness),
    [consolidated],
  );

  const { projects } = useProjects();

  // The credential half of the table. An API credential is project-scoped
  // (`SecretOrigin` identity is `(project_id, env_var)`), so it needs the
  // Project entity — `projectTypeId` alone cannot call the two actions.
  // The host always passes the resolved entity; `useProjects()` is a
  // recency-limited list, so a lookup by id here could only ever miss on an
  // instance with many projects.
  const selectedProject = project ?? null;
  const { navigation } = useDockNavigation();

  const {
    rows: credentialRows,
    specs: credentialSpecs,
    envLocalBlocked,
    envLocalBlockReason,
    envLocalPresent: envLocalKeys,
    declareCredential,
    provide: provideCredentialValue,
    deleteCredential,
  } = useCredentialConnections(selectedProject);

  const [addOpen, setAddOpen] = React.useState(false);
  const [addBusy, setAddBusy] = React.useState<string | null>(null);
  const [pendingCredential, setPendingCredential] = React.useState<CredentialSpec | null>(null);
  const [pendingDeleteCredential, setPendingDeleteCredential] = React.useState<CredentialRow | null>(null);

  /**
   * What Delete will actually do, said before it happens.
   *
   * The prediction keys off the row's STORE, which is what actually decides the
   * outcome: a declaration's locator kind comes from its definition's store
   * (`CredentialSpec.locatorFor`), and that kind picks the driver whose
   * `forget()` the backend calls. Reading `member.foundIn` instead would predict
   * from where a value was last resolved — a near-enough proxy that is not the
   * signal the backend acts on.
   *
   * One store per credential, so there are two outcomes and not three:
   * `locatorFor` gives every variable of a definition the same kind, and an
   * ad-hoc row is a single variable.
   */
  const credentialDeleteDescription = React.useMemo(() => {
    const row = pendingDeleteCredential;
    if (!row || row.sodStore !== 'env-local') {
      return t`This project stops using it and the stored value is deleted.`;
    }
    // Name the variables that are actually there — those are the lines that stay.
    const names = row.members
      .filter((m) => m.state === 'met' || m.state === 'adoptable')
      .map((m) => m.envVar)
      .join(', ');
    return names.includes(',')
      ? t`This project stops using it. ${names} stay in your .env.local — Flowpad never removes an entry from that file.`
      : t`This project stops using it. ${names} stays in your .env.local — Flowpad never removes an entry from that file.`;
  }, [pendingDeleteCredential, t]);

  const [usageForced, setUsageForced] = React.useState(false);
  const usageEnabled = usageForced || (projects?.length ?? 0) <= USAGE_EAGER_LIMIT;
  const { usage, isLoading: usageLoading } = useCredentialUsage({ projects, userTable, enabled: usageEnabled });
  // Which project row inside a usage popover is mid-attach/detach.
  const [togglingProjectId, setTogglingProjectId] = React.useState<string | null>(null);
  // The connection awaiting a delete confirmation (null = dialog closed).
  const [pendingDelete, setPendingDelete] = React.useState<ExtendedOAuthConnection | null>(null);

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
    // From the CATALOGUE, not the rendered rows: the table no longer holds
    // unconnected providers, so the everyday first-time connect is exactly the
    // case `allConnections` does not contain.
    const provider = availableProviders.find((p) => p.name.toLowerCase() === connectionId);
    if (!provider) return;
    const displayName = provider.display_name || provider.name;

    try {
      await connect(connectionId, provider.name);
    } catch (error) {
      // Surfaced, not just logged: every failure here (a provider this instance
      // cannot complete a flow for, a backend refusal) used to land in the
      // console only, so the button looked like it did nothing.
      notify.error({
        title: t`${displayName} connection failed`,
        message: errorMessage(error, t`Could not connect to ${displayName}.`),
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

  // The catalogue is whatever the table is not already showing: the table lists
  // what exists, the dialog lists what you could add. Memoized because this
  // component re-renders on usage polling and grant-status changes, and a fresh
  // array each time defeats the dialog's own memoization.
  const addableSpecs = React.useMemo(() => {
    const shown = new Set(credentialRows.map((r) => r.key));
    return credentialSpecs.filter((spec) => !shown.has(String(spec.name ?? '')));
  }, [credentialRows, credentialSpecs]);
  const addableProviders = React.useMemo(
    () =>
      availableProviders.filter(
        (p) => (grantStatuses[p.name] ?? GrantStatus.NONE) === GrantStatus.NONE,
      ),
    [availableProviders, grantStatuses],
  );

  const pickProvider = (providerName: string) => {
    setAddOpen(false);
    void handleConnect(providerName.toLowerCase());
  };

  const pickCredential = (spec: CredentialSpec) => {
    setAddOpen(false);
    setPendingCredential(spec);
  };

  /**
   * Declare one credential, with the busy flag and the failure message both
   * surfaces share. Returns whether it landed.
   */
  const declareWithBusy = async (spec: CredentialSpec, key: string): Promise<boolean> => {
    setAddBusy(key);
    try {
      await declareCredential(spec);
      return true;
    } catch (error) {
      notify.error({
        title: t`Could not add ${spec.title || key}`,
        message: errorMessage(error, t`The credential could not be added.`),
      });
      return false;
    } finally {
      setAddBusy(null);
    }
  };

  /**
   * Declare THEN provide, in that order and never the reverse: `provide-secret`
   * looks the pointer up on the project and fails when it is absent, so a value
   * written first has nowhere to go.
   */
  const saveCredential = async (values: Record<string, string>) => {
    const spec = pendingCredential;
    if (!spec) return;
    const key = String(spec.name ?? '');
    if (!(await declareWithBusy(spec, key))) return;
    setAddBusy(key);
    try {
      for (const [envVar, value] of Object.entries(values)) {
        if (value) await provideCredentialValue({ envVar, value });
      }
      setPendingCredential(null);
    } catch (error) {
      notify.error({
        title: t`Could not add ${spec.title || key}`,
        message: errorMessage(error, t`The value could not be written.`),
      });
    } finally {
      setAddBusy(null);
    }
  };

  return (
    // No frame of its own — the host supplies height and padding.
    <div className={cn('flex min-h-0 flex-col', className)} data-testid="connections-manager">
      <div className="mb-4 flex items-center gap-3">
        {header && (
          <h2 className="text-xl font-semibold">
            <Trans>Connections</Trans>
          </h2>
        )}
        <Button
          size="sm"
          className="ms-auto h-8 gap-1.5"
          onClick={() => setAddOpen(true)}
          data-testid="add-connection-open"
        >
          <Plus className="h-4 w-4" />
          <Trans>Add connection</Trans>
        </Button>
      </div>

      <AddConnectionDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        providers={addableProviders}
        specs={addableSpecs}
        onPickProvider={pickProvider}
        onPickCredential={pickCredential}
        busyKey={addBusy}
      />

      <CredentialValueForm
        spec={pendingCredential}
        presentKeys={envLocalKeys}
        blocked={envLocalBlocked}
        blockReason={envLocalBlockReason}
        busy={!!addBusy}
        onCancel={() => setPendingCredential(null)}
        onSave={saveCredential}
      />

      {envLocalBlocked && (
        <EnvLocalBlockedNotice
          reason={envLocalBlockReason}
          className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
        />
      )}

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
              <TableHead className="w-[210px] text-end">
                <Trans>Actions</Trans>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {/* FlowPad first: it is the account the app itself signs in with, so
                it heads the list rather than sorting in among the providers you
                added. Its own producer — see the component for why it cannot be
                a synthetic `allConnections` entry. */}
            <FlowpadConnectionRow />
            {/* The harness logins sit with FlowPad: both are accounts this MACHINE
                holds, above the project-scoped credential rows below. Navigation is
                the HOST's, like every other row action here — a leaf reaching for the
                router subscribes the whole table to every location change. */}
            <HarnessConnectionRows
              rows={harnessRows}
              onDetails={(worker) => openLlmSources(navigation, worker)}
            />
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
                      <ScopeChips scopes={connection.scopes} />
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

                  <TableCell className="text-end">
                    <div className="flex items-center justify-end gap-1">
                      {/* A probe spends the token, so it runs as whoever is
                          allowed to spend it — and the owner needs no grant to
                          spend their own. Offered for any held credential: with
                          a project selected the probe runs as that project (and
                          the consent gate applies), without one it runs as the
                          user. Both backends answer. */}
                      {held && (
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
                          data-testid={`connection-connect-${connection.id}`}
                        >
                          {connectingConnectionId === connection.id ? (
                            <>
                              <Loader2 className="me-1.5 h-3 w-3 animate-spin" />
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
                              <Trash2 className="me-2 h-3.5 w-3.5" />
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
            <CredentialConnectionRows
              rows={credentialRows}
              adoptingKey={addBusy}
              onDelete={(row) => setPendingDeleteCredential(row)}
              onAdopt={async (rowKey) => {
                // Declares straight away — no value form. A row is only
                // adoptable when every one of its values is ALREADY on disk, so
                // there is nothing to ask for and asking would add a click to
                // the one case that should be a single click.
                const spec = credentialSpecs.find((c) => String(c.name ?? '') === rowKey);
                if (spec) await declareWithBusy(spec, rowKey);
              }}
              onProvide={async (envVar, value) => {
                try {
                  await provideCredentialValue({ envVar, value });
                  notify.success({ title: t`${envVar} saved` });
                } catch (error) {
                  // `write_env_local` refuses when `.env.local` is committable —
                  // a security gate, so surface it rather than swallow it.
                  notify.error({
                    title: t`Could not save ${envVar}`,
                    message: errorMessage(error, t`The value could not be written.`),
                  });
                }
              }}
            />
            {/* "Nothing yet" is about what YOU added. The FlowPad row is always
                present — it is the app's own account, not a connection you chose
                — so it must not be what suppresses this line. */}
            {allConnections.length === 0 && credentialRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={CONNECTIONS_COLUMN_COUNT} className="py-8 text-center text-sm text-muted-foreground">
                  <Trans>No connections yet</Trans>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Delete says what will actually happen, BEFORE it happens. The row
          already knows which store each value came from (`foundIn`), so the
          one case where Delete is not total — a value in the user's own
          `.env.local`, which Flowpad never removes from — is named here rather
          than discovered afterwards. */}
      <ConfirmDialog
        open={!!pendingDeleteCredential}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteCredential(null);
        }}
        title={t`Delete ${pendingDeleteCredential?.title ?? ''}?`}
        description={credentialDeleteDescription}
        confirmLabel={t`Delete`}
        variant="destructive"
        onConfirm={() => {
          const row = pendingDeleteCredential;
          setPendingDeleteCredential(null);
          if (!row) return;
          void (async () => {
            try {
              const { kept } = await deleteCredential(row);
              // Report what the BACKEND did, not what the dialog predicted: the
              // driver decides, and a value could have moved stores since the
              // table was painted.
              notify.success({
                title: t`${row.title} deleted`,
                // No singular/plural split here, unlike the dialog: "stayed"
                // reads the same for one name or several.
                ...(kept.length
                  ? { message: t`${kept.join(', ')} stayed in your .env.local.` }
                  : {}),
              });
            } catch (error) {
              notify.error({
                title: t`Could not delete ${row.title}`,
                message: errorMessage(error, t`It may be only partly removed.`),
              });
            }
          })();
        }}
      />

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

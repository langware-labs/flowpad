import { usePrimaryContentReady } from '@sdk/react/primary-content';
import { i18n } from '@lingui/core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import {
  Capability,
  capabilityManager,
  cloudManager,
  CapabilityKinds,
  copyToClipboard,
  HARNESS_CAPABILITY_KINDS,
  LMApiProvider,
  LOGIN_CANCELLED,
  HubLogin,
  InstallState,
  LoginState,
  LOGIN_SUPERSEDED,
  llmSourcesService,
  lmKeysService,
  statusService,
  TypeId,
  WorkerModelTier,
  type LmApiKeySummary,
  type LmApiKeyValidation,
} from '@sdk';
import { useCloudStatus, useEntity } from '@sdk/react/hooks';
import flowpadIcon from '@src/assets/flowpad-icon.png';
import { errorMessage } from '@src/lib/error-message';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { useLlmSources } from '@src/components/llm-sources/use-llm-sources';
import { harnessStatus, useStatusRecord } from '@src/components/status/use-status-record';
import { notify } from '@src/notifications';
import { PROVIDER_META } from '@src/tabs/provider-meta';
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Loader2,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { lucideByName } from '@src/lib/lucide-by-name';
import { openExternal } from '@src/lib/open-external';
import { openWikiModal } from '@src/components/wiki-tip/wiki-modal';
import { openLlmEndpoint } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { TokenPlanChip } from '@src/components/token-plan/TokenPlanChip';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewMode } from '@src/contexts/view-mode-context';
import { openHarnessLoginModal, useHarnessLoginStore } from './harness-login-store';

const INSTALL_WIKI_PAGE = 'Install a harness';

const workerOf = (kind: string) => kind.split('.')[1];

type AuthMode = 'device' | 'api';

/**
 * What a harness row says, read straight off the status record: not installed, or its login.
 * `signing_in` also covers a sign-in this screen just started and the backend has not yet
 * reported — the one state the row knows before the record does.
 */
type RowState = LoginState | InstallState.NotInstalled;

const PROVIDER_LABEL: Record<string, string> = {
  [LMApiProvider.OpenRouter]: 'OpenRouter',
  [LMApiProvider.Anthropic]: 'Anthropic',
  [LMApiProvider.OpenAI]: 'OpenAI',
  [LMApiProvider.FlowPad]: 'FlowPad Hub endpoint',
};

/** Display name for a provider value, falling back to the raw value. */
const providerLabel = (provider: string) => PROVIDER_LABEL[provider] ?? provider;

/** Shared per-harness state hook: the harness's status record (installed, login, account,
 *  what it can authenticate with), what funds it, its live Capability row for the sign-in
 *  flow's own data (code, URL), and the actions. Nothing here decides a fact. */
function useHarness(kind: string) {
  const { t } = useLingui();
  const { status: record } = useStatusRecord();
  const { status: funding } = useLlmSources();
  const h = harnessStatus(record, kind);
  const snapshot = capabilityManager.getSnapshot(kind);
  const capabilityId = snapshot.capability?.id ?? null;
  const typeId = useMemo(() => (capabilityId ? new TypeId(Capability.type, capabilityId) : null), [capabilityId]);
  const { data: capability } = useEntity<Capability>(typeId, { enabled: !!typeId, watch: true });

  const [busy, setBusy] = useState(false);
  // Separate from `busy` so re-testing auth doesn't read as a sign-in in flight.
  const [testing, setTesting] = useState(false);
  const [pasted, setPasted] = useState('');

  // What this harness can authenticate with, as the backend serves it, and which of those this
  // box actually has: a stored key for the provider, or a FlowPad login for the hub endpoint.
  const supportsDevice = h?.has_device_login ?? true;
  const stored = new Set((record?.keys ?? []).filter((k) => k.stored).map((k) => k.provider));
  const configuredProviders = [
    ...(h?.key_providers ?? []).filter((p) => stored.has(p)),
    ...(record?.hub.login === HubLogin.SignedIn ? [LMApiProvider.FlowPad as string] : []),
  ];
  const apiAvailable = configuredProviders.length > 0;

  // A key-only harness is in `api` mode by definition -- reading `auth_mode` there would let a
  // stale 'device' (the column default) put the row into a mode it can never satisfy.
  const authMode: AuthMode = supportsDevice ? ((capability?.auth_mode as AuthMode) ?? 'device') : 'api';
  const rawProvider = capability?.api_provider ?? configuredProviders[0] ?? LMApiProvider.OpenRouter;
  const activeProvider = configuredProviders.includes(rawProvider) ? rawProvider : (configuredProviders[0] ?? rawProvider);

  const setAuthMode = useCallback(
    async (mode: AuthMode, provider?: string) => {
      try {
        await capabilityManager.setAuthMode(kind, mode, mode === 'api' ? (provider ?? activeProvider) : null);
      } catch {
        notify.error({ title: t`Could not change sign-in method`, durationMs: 4000 });
      }
    },
    [kind, activeProvider, t],
  );

  const state: RowState =
    h?.install === InstallState.NotInstalled
      ? InstallState.NotInstalled
      : busy
        ? LoginState.SigningIn
        : (h?.login ?? LoginState.NotChecked);

  const signIn = useCallback(async () => {
    if (!capability) return;
    setBusy(true);
    try {
      await capability.deviceLogin();
    } catch {
      notify.error({ title: t`Could not start sign-in`, durationMs: 4000 });
    } finally {
      setBusy(false);
    }
  }, [capability, t]);

  // Re-run the vendor's own auth check. The backend writes the verdict onto the status record
  // and pushes it, so the row follows; the toast confirms the outcome.
  const testAuth = useCallback(async () => {
    if (!capability) return;
    setTesting(true);
    try {
      // User-invoked: this is the one probe allowed to clear a recorded refusal.
      const r = await capability.authStatus(true);
      if (r.status === 'logged_in') {
        notify.success({ title: t`Still signed in`, message: r.message || undefined, durationMs: 3000 });
      } else {
        notify.warning({
          title: t`Not signed in — please re-authenticate`,
          message: r.message || undefined,
          durationMs: 5000,
        });
      }
    } catch {
      notify.error({ title: t`Could not check sign-in`, durationMs: 4000 });
    } finally {
      setTesting(false);
    }
  }, [capability, t]);

  const copyAndOpen = useCallback(async () => {
    if (!capability?.login_url) return;
    if (capability.login_code) {
      try {
        await copyToClipboard(capability.login_code);
        notify.success({ title: t`Code copied — paste it in the page we opened`, durationMs: 2500 });
      } catch {
        /* user can read the code from the dialog */
      }
    }
    openExternal(capability.login_url);
  }, [capability, t]);

  const submitCode = useCallback(async () => {
    if (!capability || !pasted.trim()) return;
    await capability.submitLoginCode(pasted.trim());
    setPasted('');
  }, [capability, pasted]);

  const worker = h?.worker_type ?? workerOf(kind);
  // Brand tints for the vendors that have one; any other harness falls back to its registry icon.
  const meta = (PROVIDER_META as Partial<Record<string, (typeof PROVIDER_META)['claude']>>)[worker];
  const name = h?.label || capability?.name || worker;
  const Icon = meta?.Icon ?? (h?.icon ? lucideByName(h.icon) : undefined);

  // What pays for this harness, from the funding layer — never re-derived from the mode toggle.
  const picked = funding?.resolved?.[kind] ?? null;
  const fundingBadge = picked
    ? { label: t`Funded by ${picked.name}`, tone: 'emerald' as const, title: undefined }
    : { label: t`Not funded`, tone: 'amber' as const, title: funding?.blocked?.[kind] || undefined };

  return {
    capability,
    state,
    // The login's own sentence — the harness's refusal, or the probe's error — when it is not
    // signed in. Empty otherwise.
    statusReason:
      state === LoginState.SignedOut || state === LoginState.Error ? h?.login_message?.trim() || null : null,
    statusText: statusTextFor(state),
    name,
    account: h?.account.identity || null,
    installCommand: h?.install_command || null,
    Icon,
    iconClassName: meta?.iconClassName ?? '',
    pasted,
    setPasted,
    signIn,
    copyAndOpen,
    submitCode,
    testing,
    testAuth,
    authMode,
    fundingBadge,
    supportsDevice,
    configuredProviders,
    activeProvider,
    apiAvailable,
    setAuthMode,
  };
}

const AUTH_BADGE_TONE: Record<'emerald' | 'amber' | 'sky' | 'rose', string> = {
  emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-500',
  sky: 'border-sky-500/30 bg-sky-500/10 text-sky-500',
  rose: 'border-destructive/30 bg-destructive/10 text-destructive',
};

/** What funds this harness, as the funding layer answers it. */
function FundingBadge({
  badge,
  testId,
}: {
  badge: { label: string; tone: 'emerald' | 'amber'; title?: string };
  testId?: string;
}) {
  return (
    <Badge variant="outline" data-testid={testId} title={badge.title} className={`gap-1 ${AUTH_BADGE_TONE[badge.tone]}`}>
      <KeyRound className="h-3 w-3" />
      {badge.label}
    </Badge>
  );
}

/**
 * `label` is a lazy {@link MessageDescriptor}, not a `t` string. This table is
 * module-level, so a `t` macro here runs ONCE at import — before any catalog is
 * activated — and freezes the boot locale's English into the badge for the rest
 * of the session. {@link statusTextFor} resolves the descriptor at render instead,
 * which is also what re-reads it after a locale switch.
 *
 * One word per status-record state: the row says what the record says, nothing softer.
 */
const AMBER = { dot: 'bg-amber-400 shadow-[0_0_7px] shadow-amber-400/60', tone: 'text-amber-500' };
const SKY = { dot: 'bg-sky-400 shadow-[0_0_7px] shadow-sky-400/60 animate-pulse', tone: 'text-sky-500' };
const MUTED = { dot: 'bg-muted-foreground/40', tone: 'text-muted-foreground' };
const STATUS_TEXT: Record<RowState, { label: MessageDescriptor; dot: string; tone: string }> = {
  [LoginState.SignedIn]: {
    label: msg`Signed in`,
    dot: 'bg-emerald-400 shadow-[0_0_7px] shadow-emerald-400/60',
    tone: 'text-emerald-500',
  },
  [LoginState.SigningIn]: { label: msg`Signing in…`, ...SKY },
  [LoginState.SignedOut]: { label: msg`Not signed in`, ...AMBER },
  [LoginState.Error]: { label: msg`Sign-in failed`, ...AMBER },
  // Installed, never probed: an unknown login is not a signed-in one.
  [LoginState.NotChecked]: { label: msg`Not checked yet`, ...MUTED },
  [LoginState.NA]: { label: msg`Uses a key`, ...MUTED },
  // A CLI that is not installed funds nothing, so it IS the funding answer — calling it
  // "Not signed in" hid the one fact that explains why the row cannot pay.
  [InstallState.NotInstalled]: { label: msg`Not installed`, ...MUTED },
};

/** A state's visuals with its label resolved in the ACTIVE locale. */
function statusTextFor(state: RowState): { label: string; dot: string; tone: string } {
  const entry = STATUS_TEXT[state];
  return { ...entry, label: i18n._(entry.label) };
}

/**
 * ONE row, for every kind of thing that can pay for a call.
 *
 * FlowPad, the four assistants and the LLM-key store are different underneath — a hub login, a
 * vendor device login, a stored secret — and they were each drawn differently, which made the
 * dialog read as three lists stacked up. They answer the SAME question, so they get the same
 * line: mark, name, the default tick, what state it is in, and the one button that changes it.
 *
 * The status is a button too, and it opens the same place. It is the word the user reads when
 * they are deciding what to click, so making it inert forced a second, smaller decision about
 * WHERE to click to act on what they just read.
 */
function SetupRow({
  mark,
  name,
  status,
  action,
  onOpen,
  busy,
  isDefault,
  onMakeDefault,
  emphasis,
  testId,
  rowOpens = true,
  below,
}: {
  mark: React.ReactNode;
  name: React.ReactNode;
  /** Short state, in the row's own vocabulary: "Signed in", "Key not set". */
  status: { label: string; dot: string; tone: string };
  /** The button's label — "Sign in", "Manage", "Details". */
  action: React.ReactNode;
  onOpen: () => void;
  busy?: boolean;
  /** Present only on rows that CAN be the default assistant (the four harnesses). */
  isDefault?: boolean;
  onMakeDefault?: () => void;
  emphasis?: boolean;
  testId: string;
  /** Whether a click anywhere on the row does what the button does. Off where the button's action
   *  is not a harmless "open": FlowPad's starts a browser sign-in, and a stray click on its name
   *  started one the person never asked for. */
  rowOpens?: boolean;
  /** A line under the row, inside its border — what the row is waiting on, and how to get out. */
  below?: React.ReactNode;
}) {
  const { t } = useLingui();
  // The buttons below stop at themselves: the row's own click would otherwise run `onOpen` a SECOND
  // time for the same click — harmless for a panel that opens, but for FlowPad it started two sign-ins.
  const own = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpen();
  };
  return (
    // The WHOLE row opens the panel, not just the button on its end. That was the affordance
    // before this became a multi-control row, and losing it is a silent downgrade: a list of
    // big tappable rows that suddenly only respond on a 92px target at the far right.
    // Deliberately a div with an onClick rather than a <button>: it contains buttons, and
    // nesting them is invalid. Keyboard users reach the same place via the action button,
    // which is a real button and a real tab stop.
    <div
      data-testid={testId}
      onClick={rowOpens ? onOpen : undefined}
      className={`flex w-full flex-col rounded-xl border transition-colors ${rowOpens ? 'cursor-pointer' : ''} ${
        emphasis
          ? `border-primary/40 bg-primary/5 ${rowOpens ? 'hover:bg-primary/10' : ''}`
          : 'border-border/70 bg-card/40 hover:bg-accent/40'
      }`}
    >
      <div className="flex w-full items-center gap-3 p-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border/60 bg-background/70">
          {mark}
        </div>

        <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{name}</span>

        {/* The default tick, in place of the old "Default assistant" dropdown: the mark sits ON
          the thing it describes, and clicking it is how you move it. A dropdown listing the
          same four names the list already shows was a second copy of the list. */}
        {onMakeDefault && (
          <button
            type="button"
            // Stops at the tick: the row opens the panel, but making something the default is a
            // different action and must not also navigate away from the list.
            onClick={(e) => {
              e.stopPropagation();
              onMakeDefault();
            }}
            title={isDefault ? t`This is your default assistant` : t`Make this the default assistant`}
            aria-pressed={isDefault}
            data-testid={`${testId}-default`}
            className={`shrink-0 rounded-md p-1 transition-colors ${
              isDefault ? 'text-emerald-500' : 'text-muted-foreground/25 hover:text-muted-foreground'
            }`}
          >
            <Check className="h-4 w-4" />
          </button>
        )}

        {/* Status and button both open the same panel — see the component docstring. */}
        <button
          type="button"
          onClick={rowOpens ? own : (e) => e.stopPropagation()}
          data-testid={`${testId}-status`}
          // Not a tab stop: it goes exactly where the button beside it goes, so keyboard users
          // would hit the same destination twice per row. It also made Radix's open-autofocus
          // land on the FIRST row's status, drawing a ring around the words "Not signed in" that
          // read as a validation error on a dialog that had not been touched yet.
          tabIndex={-1}
          className="flex shrink-0 items-center gap-1.5 text-xs hover:underline"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
          <span className={status.tone}>{status.label}</span>
        </button>

        <Button
          size="sm"
          variant={emphasis ? 'default' : 'outline'}
          className="h-8 w-[92px] shrink-0"
          disabled={busy}
          onClick={own}
          data-testid={`${testId}-action`}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : action}
        </Button>
      </div>
      {below}
    </div>
  );
}

/** One assistant, as a {@link SetupRow}. */
function HarnessListRow({
  kind,
  onOpen,
  isDefault,
  onMakeDefault,
}: {
  kind: string;
  onOpen: () => void;
  isDefault?: boolean;
  onMakeDefault: () => void;
}) {
  const { statusText, name, Icon, iconClassName, supportsDevice, apiAvailable } = useHarness(kind);
  const worker = workerOf(kind);
  // A key-only harness has no login, so "Not signed in" would name a state it cannot leave.
  // What it actually lacks is a key, and that is what the row should say.
  const status = supportsDevice
    ? statusText
    : apiAvailable
      ? { label: i18n._(msg`Key set`), dot: 'bg-emerald-400', tone: 'text-emerald-500' }
      : { label: i18n._(msg`Key not set`), dot: 'bg-amber-400', tone: 'text-amber-500' };

  return (
    <SetupRow
      testId={`harness-row-${worker}`}
      mark={Icon && <Icon className={`h-5 w-5 ${iconClassName}`} />}
      name={name}
      status={status}
      // Says what the panel behind it DOES. "Details" described a place, not an action, and
      // this row's whole purpose is getting the thing funded. A key-only harness drops the
      // "Login" half — there is nothing to log in to, so offering the word is a false promise.
      action={supportsDevice ? <Trans>Login/API key</Trans> : <Trans>API key</Trans>}
      onOpen={onOpen}
      isDefault={isDefault}
      onMakeDefault={onMakeDefault}
    />
  );
}

/**
 * FlowPad's own account, as the first {@link SetupRow}.
 *
 * It belongs in this list because it answers the same question the rows below it answer — what
 * pays for your LLM calls — and it is the only answer that asks the user for nothing they do
 * not already have: a new account is granted access to a hub endpoint, so signing in IS the
 * whole setup.
 *
 * Sign-in only, by request. There is a `cloudManager.logout()`, but signing OUT of FlowPad is
 * an account action with consequences far beyond this dialog (sharing, backup, the hub socket),
 * and offering it beside four "Details" buttons framed it as a funding toggle.
 *
 * Connect is awaited HERE rather than routed through `useOAuthConnection`, for the reason
 * `flowpad-connection-row.tsx` documents: `flowpad_cloud` registers no OAuth flow, so
 * `OAUTH_FLOW_COMPLETE` never fires and the hook's only path for clearing its spinner never runs.
 */
function FlowpadListRow({ onConnected }: { onConnected: () => void }) {
  const { t } = useLingui();
  const { cloudUrl } = useCloudStatus();
  const { status: record } = useStatusRecord();
  const { status: funding } = useLlmSources();
  const [busy, setBusy] = useState(false);
  const hub = record?.hub;
  const loggedIn = hub?.login === HubLogin.SignedIn;
  const signingIn = busy || hub?.login === HubLogin.SigningIn;
  // Signed in ≠ funding something: a hub account with no bound endpoint is signed in but has
  // nothing to give out. The funding layer says which: a harness whose resolved source is a hub
  // endpoint is being paid for by this account.
  const isFunding = Object.values(funding?.resolved ?? {}).some(
    (pick) => !!pick && funding?.endpoints[pick.endpoint_typeid]?.kind === 'hub',
  );

  // The OAuth-style flow this awaits can settle `login.status` a moment after its own promise
  // resolves, not necessarily within it — watching the FLIP here (never on mount, when a
  // returning user is already signed in) is what catches it either way, without a second
  // "did we just do this" flag of its own.
  const wasLoggedIn = useRef(loggedIn);
  useEffect(() => {
    if (loggedIn && !wasLoggedIn.current) onConnected();
    wasLoggedIn.current = loggedIn;
  }, [loggedIn, onConnected]);

  const connect = async () => {
    if (loggedIn) {
      // Signing in already IS choosing FlowPad — there is no separate "pick" step, and this
      // row's own button reads "Signed in" either way. Clicking it while it is actually funding
      // something is a person CONFIRMING that choice, same as a fresh sign-in — so it goes
      // through the same `onConnected` banner (Close / Keep browsing), not a toast with no
      // way out. Only the "signed in but funds nothing" case below has nothing to confirm.
      if (isFunding) {
        onConnected();
      } else {
        notify.warning({
          title: t`Signed in, but not funding anything`,
          message: t`This FlowPad account has no LLM source bound to it yet — ask your organization for one, or connect a different assistant below.`,
          durationMs: 6000,
        });
      }
      return;
    }
    setBusy(true);
    try {
      await cloudManager.login();
    } catch (error) {
      // Cancel, or "Open the page again" starting a newer attempt: choices, not failures to report.
      const quiet = error instanceof Error && (error.message === LOGIN_CANCELLED || error.message === LOGIN_SUPERSEDED);
      if (!quiet) {
        notify.error({
          title: t`Could not sign in to FlowPad`,
          message: errorMessage(error, t`The login did not complete.`),
        });
      }
    } finally {
      setBusy(false);
    }
  };

  // A browser sign-in waits for the login page with nothing on this screen moving, and the page may
  // never have shown (or was closed). Say where the next step is, and give a way out of the wait.
  const waiting = signingIn ? (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-primary/20 px-3 py-2 text-xs"
      data-testid="harness-row-flowpad-waiting"
    >
      <span className="text-muted-foreground">
        <Trans>Finish signing in on the page that opened in your browser.</Trans>
      </span>
      <span className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          onClick={() => void cloudManager.login()}
          data-testid="harness-row-flowpad-reopen"
        >
          <Trans>Open the page again</Trans>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          onClick={() => void cloudManager.cancelLogin()}
          data-testid="harness-row-flowpad-cancel"
        >
          <Trans>Cancel</Trans>
        </Button>
      </span>
    </div>
  ) : null;

  const account = [cloudUrl, hub?.email || null]
    .filter(Boolean)
    .join(' · ');

  return (
    <SetupRow
      testId="harness-row-flowpad"
      emphasis
      busy={signingIn}
      mark={<img src={flowpadIcon} alt="" className="h-5 w-5 rounded-sm" title={account || undefined} />}
      name="FlowPad"
      status={statusTextFor(signingIn ? LoginState.SigningIn : loggedIn ? LoginState.SignedIn : LoginState.SignedOut)}
      action={loggedIn ? <Trans>Signed in</Trans> : <Trans>Sign in</Trans>}
      onOpen={() => void connect()}
      rowOpens={false}
      below={waiting}
    />
  );
}

/**
 * The LLM key store, as a {@link SetupRow}.
 *
 * The keys form used to sit expanded at the top of this dialog, which made the first thing the
 * user met a "Paste API key" box — the most technical answer, and the least likely one for
 * whoever opened this because nothing works. As a row it keeps its place in the list without
 * asking its question first.
 *
 * "Key not set" rather than "Not signed in", because a key is not a login: there is nothing to
 * sign in to, and naming a state it can never reach would be a false instruction.
 */
function KeysListRow({ onOpen }: { onOpen: () => void }) {
  const { status: record } = useStatusRecord();
  const configured = (record?.keys ?? []).filter((k) => k.stored).length;
  return (
    <SetupRow
      testId="row-llm-keys"
      mark={<KeyRound className="h-5 w-5 text-muted-foreground" />}
      name={<Trans>LLM API keys</Trans>}
      status={
        configured
          ? { label: i18n._(msg`Key set`), dot: 'bg-emerald-400', tone: 'text-emerald-500' }
          : { label: i18n._(msg`Key not set`), dot: 'bg-amber-400', tone: 'text-amber-500' }
      }
      // "API key", not "Manage": every other button in this list names the credential it
      // takes you to set, and one row saying what it DOES to that credential instead read as
      // a different kind of control.
      action={<Trans>API key</Trans>}
      onOpen={onOpen}
    />
  );
}

/** Central LLM-key management — the base layer. Add a key for any provider, see
 *  all configured keys, test validity, and delete. Shared across the modal;
 *  harnesses only consume these keys (they never enter them). */
function LlmKeysSection({ keys, refreshKeys }: { keys: LmApiKeySummary[]; refreshKeys: () => Promise<void> }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { setOpen } = useHarnessLoginStore();
  // A managed row's `detail` is the hub endpoint typeid; Open lands on that
  // endpoint's page (page=hub), where its chain, limits and usage live.
  const openEndpoint = (detail: string) => {
    setOpen(false);
    openLlmEndpoint(navigation, detail);
  };
  // Only providers a user can key by hand go in the paste-a-key select; managed
  // ones (the FlowPad hub endpoint) appear in the configured list when bound.
  const allProviders = Object.values(LMApiProvider).filter((p) => p !== LMApiProvider.FlowPad);
  const [provider, setProvider] = useState<string>(allProviders[0]);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Per-provider validity: undefined = untested this session.
  const [validity, setValidity] = useState<Record<string, LmApiKeyValidation | undefined>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const configured = keys.filter((k) => k.configured);

  const onSave = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      const res = await lmKeysService.setLmApi(value.trim(), provider as LMApiProvider);
      setValue('');
      setValidity((v) => ({ ...v, [provider]: { valid: res.valid, message: res.message } }));
      await refreshKeys();
      if (res.valid) notify.success({ title: t`Key saved & valid`, message: providerLabel(provider) });
      else notify.error({ title: t`Key saved but invalid`, message: res.message ?? providerLabel(provider) });
    } catch (error) {
      notify.error({ title: t`Error`, message: error instanceof Error ? error.message : t`Failed to save key` });
    } finally {
      setBusy(false);
    }
  };

  const onTest = async (p: string) => {
    setTesting(p);
    try {
      const res = await lmKeysService.testLmApi(p as LMApiProvider);
      setValidity((v) => ({ ...v, [p]: res }));
    } catch {
      setValidity((v) => ({ ...v, [p]: { valid: false, message: t`Test failed` } }));
    } finally {
      setTesting(null);
    }
  };

  const onDelete = async (p: string) => {
    await lmKeysService.deleteLmApi(p as LMApiProvider);
    setValidity((v) => ({ ...v, [p]: undefined }));
    await refreshKeys();
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <KeyRound className="h-4 w-4" />
        <Trans>LLM API keys</Trans>
      </div>

      <div className="flex gap-2">
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger className="h-10 w-[130px]" data-testid="keys-provider-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allProviders.map((p) => (
              <SelectItem key={p} value={p}>
                {providerLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void onSave()}
          placeholder={t`Paste API key`}
          className="h-10"
          data-testid="keys-input"
        />
        <Button disabled={busy || !value.trim()} onClick={() => void onSave()} data-testid="keys-save">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trans>Save</Trans>}
        </Button>
      </div>

      {configured.length > 0 && (
        <ul className="flex flex-col gap-1">
          {configured.map((k) => {
            const v = validity[k.provider];
            return (
              <li
                key={k.provider}
                data-testid={`keys-row-${k.provider}`}
                className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background/60 px-2.5 py-1.5 text-sm"
              >
                <span className="flex items-center gap-2">
                  {providerLabel(k.provider)}
                  {k.managed && k.name && (
                    <span className="text-muted-foreground" data-testid={`keys-endpoint-name-${k.provider}`}>
                      {k.name}
                    </span>
                  )}
                  {k.managed && (
                    <Badge
                      variant="outline"
                      className={`gap-1 ${AUTH_BADGE_TONE.sky}`}
                      title={k.detail ?? undefined}
                      data-testid={`keys-managed-${k.provider}`}
                    >
                      <Trans>via hub login</Trans>
                    </Badge>
                  )}
                  {k.managed && <TokenPlanChip />}
                  {v && (
                    <Badge
                      variant="outline"
                      className={`gap-1 ${v.valid ? AUTH_BADGE_TONE.emerald : AUTH_BADGE_TONE.rose}`}
                    >
                      {v.valid ? <Check className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                      {v.valid ? <Trans>Valid</Trans> : <Trans>Invalid</Trans>}
                    </Badge>
                  )}
                </span>
                <span className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7"
                    disabled={testing === k.provider}
                    data-testid={`keys-test-${k.provider}`}
                    onClick={() => void onTest(k.provider)}
                  >
                    {testing === k.provider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trans>Test</Trans>}
                  </Button>
                  {k.managed && k.detail && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7"
                      data-testid={`keys-open-${k.provider}`}
                      onClick={() => openEndpoint(k.detail as string)}
                    >
                      <Trans>Open</Trans>
                    </Button>
                  )}
                  {!k.managed && (
                    <button
                      type="button"
                      aria-label={t`Delete key`}
                      data-testid={`keys-delete-${k.provider}`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setConfirmDelete(k.provider)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={t`Delete this key?`}
        description={t`The stored API key for this provider is removed from this machine. You can add it again later.`}
        onConfirm={() => {
          if (confirmDelete) void onDelete(confirmDelete);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}

/** Detail: one assistant, focused on the single next action. Exported for the
 *  unit test that pins the not-installed arm. */
export function HarnessDetail({
  kind,
  onBack,
  onDone,
  onManageKeys,
}: {
  kind: string;
  onBack: () => void;
  /** Open the LLM API keys panel. A key-only harness has no other way forward, and pointing
   *  at a section the user has to go and find themselves is not a way forward. */
  onManageKeys: () => void;
  /** Dismiss the whole modal. "Done" means the sign-in is finished, so the user
   *  goes back to what they were doing — NOT one level up into the assistants
   *  list, which just reads as a second popup opening by itself. */
  onDone: () => void;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const {
    capability,
    state,
    statusReason,
    statusText: stRaw,
    name,
    account,
    installCommand,
    Icon,
    iconClassName,
    pasted,
    setPasted,
    signIn,
    copyAndOpen,
    submitCode,
    testing,
    testAuth,
    authMode,
    fundingBadge,
    supportsDevice,
    configuredProviders,
    activeProvider,
    apiAvailable,
    setAuthMode,
  } = useHarness(kind);

  // The SAME status the row shows. A key-only harness reads "Key not set", never "Not signed
  // in": the panel is reached by clicking that row, and the two disagreeing about what is
  // wrong is the fastest way to make a user distrust both.
  const st = supportsDevice
    ? stRaw
    : apiAvailable
      ? { label: i18n._(msg`Key set`), dot: 'bg-emerald-400', tone: 'text-emerald-500' }
      : { label: i18n._(msg`Key not set`), dot: 'bg-amber-400', tone: 'text-amber-500' };

  // The install one-liner for THIS machine, or empty when the vendor publishes no unattended
  // route here — served on the status record, so the modal offers exactly what the
  // Capabilities page and the "harness is required" dialog offer.

  // Types the command at a prompt and submits it. Dismisses
  // the modal on the way out so the terminal it just opened is what they see —
  // leaving a dialog over the thing it told them to look at reads as a bug.
  const tryAutoInstall = useCallback(() => {
    if (!installCommand) return;
    onDone();
    void navigation.openNewShell({ startCommand: installCommand, viewMode: ViewMode.Advanced });
  }, [installCommand, navigation, onDone]);

  return (
    <div style={{ animation: 'hlIn 260ms cubic-bezier(0.16,1,0.3,1) both' }} className="flex flex-col">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
        <Trans>All assistants</Trans>
      </button>

      {/* identity */}
      <div className="flex flex-col items-center text-center">
        <div className="grid h-16 w-16 place-items-center rounded-2xl border border-border/60 bg-background/70">
          {Icon && <Icon className={`h-9 w-9 ${iconClassName}`} />}
        </div>
        <DialogTitle className="mt-3 text-xl font-semibold">{name}</DialogTitle>
        <div className="mt-1.5 flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${st.dot}`} />
          <span className={`text-sm ${st.tone}`}>{st.label}</span>
          <FundingBadge badge={fundingBadge} testId="harness-detail-authmode" />
        </div>
      </div>

      {/* Sign-in method: device login vs a configured LLM key. The "LLM key"
          option is disabled until a key exists for a provider this harness
          supports (keys are managed in the LLM API keys section above). */}
      {/* Shown whether or not the CLI is installed.
          Hiding it behind "not installed" made the panel a dead end: the user came here to
          sign in or paste a key, and got an install advert with no sign of the thing they
          asked for. Installing is a PREREQUISITE, not a different screen — so the choice
          leads, and the install prompt sits underneath it as the footnote it is. */}
      {
        <div className="mt-5 flex flex-col gap-3">
          {/* Only rendered when there are two modes to choose between. A key-only harness
              (OpenCode) showed a toggle whose 'Device login' half did nothing. */}
          {supportsDevice && (
            <div className="flex rounded-lg border border-border/60 p-0.5" data-testid="harness-authmode-toggle">
              {(['device', 'api'] as const).map((mode) => {
                const disabled = mode === 'api' && !apiAvailable;
                return (
                  <button
                    key={mode}
                    type="button"
                    disabled={disabled}
                    data-testid={`harness-authmode-${mode}`}
                    title={disabled ? t`Add a key in "LLM API keys" above to use it here` : undefined}
                    onClick={() => void setAuthMode(mode, activeProvider)}
                    className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
                      authMode === mode
                        ? 'bg-accent font-medium text-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                  >
                    {mode === 'device' ? <Trans>Device login</Trans> : <Trans>LLM key</Trans>}
                  </button>
                );
              })}
            </div>
          )}
          {authMode === 'api' && apiAvailable && (
            <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-muted/20 p-3">
              <span className="text-xs text-muted-foreground">
                <Trans>Use which key</Trans>
              </span>
              <Select value={activeProvider} onValueChange={(p) => void setAuthMode('api', p)}>
                <SelectTrigger className="h-9" data-testid="harness-provider-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {configuredProviders.map((p) => (
                    <SelectItem key={p} value={p}>
                      {providerLabel(p)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="flex items-center gap-1.5 text-sm text-emerald-500">
                <Check className="h-4 w-4" />
                {activeProvider === (LMApiProvider.FlowPad as string) ? (
                  <Trans>Using {providerLabel(activeProvider)}</Trans>
                ) : (
                  <Trans>Using {providerLabel(activeProvider)} key</Trans>
                )}
              </span>
            </div>
          )}
        </div>
      }

      {/* Body per status — the device sign-in flow, hidden in key mode because none of it
          applies... EXCEPT for a harness that has no device mode at all. `authMode` is forced
          to `api` there, so this container hid the key-only branch — the one thing that
          harness's panel exists to show. Its "Add an API key" button rendered and was
          invisible: present in the DOM, unclickable, and the panel looked like a dead end. */}
      <div className={`mt-6 ${authMode === 'api' && supportsDevice ? 'hidden' : ''}`}>
        {state === LoginState.SignedIn ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-500">
              <Check className="h-4 w-4" />
              <Trans>You're signed in and ready to go.</Trans>
            </div>
            {account && (
              <span className="text-xs text-muted-foreground" data-testid="harness-account">
                {account}
              </span>
            )}
            <div className="flex w-full gap-2">
              <Button
                variant="outline"
                className="flex-1 gap-1.5"
                disabled={testing}
                data-testid="harness-test-auth"
                onClick={() => void testAuth()}
              >
                {testing && <Loader2 className="h-4 w-4 animate-spin" />}
                <Trans>Test</Trans>
              </Button>
              <Button variant="outline" className="flex-1" data-testid="harness-done" onClick={onDone}>
                <Trans>Done</Trans>
              </Button>
            </div>
          </div>
        ) : state === LoginState.SigningIn && (capability?.login_url || capability?.login_code) ? (
          <div className="flex flex-col gap-4">
            <DialogDescription className="text-center text-sm text-muted-foreground">
              <Trans>Two quick steps in your browser:</Trans>
            </DialogDescription>

            {capability?.login_code && (
              <div className="flex flex-col items-center gap-1.5">
                <span className="text-xs text-muted-foreground">
                  <Trans>1. Copy this code</Trans>
                </span>
                <div className="flex items-center gap-0.5 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-2.5">
                  {capability.login_code.split('').map((ch, i) => (
                    <span
                      key={i}
                      className={
                        ch === '-'
                          ? 'px-1 font-mono text-2xl text-muted-foreground/40'
                          : 'select-all font-mono text-2xl font-bold tabular-nums'
                      }
                    >
                      {ch}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <Button className="w-full gap-1.5" onClick={() => void copyAndOpen()}>
              {capability?.login_code ? (
                <Trans>2. Copy &amp; open the sign-in page</Trans>
              ) : (
                <Trans>Open the sign-in page</Trans>
              )}
              <ArrowUpRight className="h-4 w-4" />
            </Button>

            {capability?.login_accepts_code && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">
                  <Trans>3. Your browser will show a code — paste it here</Trans>
                </span>
                <div className="flex gap-2">
                  <Input
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void submitCode()}
                    placeholder={t`Paste code from browser`}
                    className="h-10"
                  />
                  <Button disabled={!pasted.trim()} onClick={() => void submitCode()}>
                    <Trans>Done</Trans>
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <Trans>Waiting for you to approve…</Trans>
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={() => void capability?.cancelDeviceLogin()}
              >
                <Trans>Cancel</Trans>
              </button>
            </div>
          </div>
        ) : !supportsDevice ? (
          /* Key-only (OpenCode): there is no account to sign into, so a sign-in button here
             would do nothing. It still needs a way FORWARD — this used to say "add one under
             LLM API keys above", which was a dead end twice over: the keys form is no longer
             above (it is its own row now), and telling someone where to go is not the same as
             taking them there. */
          <div className="flex flex-col items-center gap-4 text-center">
            <DialogDescription className="text-sm text-muted-foreground">
              {apiAvailable ? (
                <Trans>{name} has no account to sign into — it runs on an LLM key.</Trans>
              ) : (
                <Trans>{name} has no account to sign into — it runs on an LLM key. Add one to get it working.</Trans>
              )}
            </DialogDescription>
            <Button className="w-full gap-1.5" onClick={onManageKeys} data-testid="harness-manage-keys">
              <KeyRound className="h-4 w-4" />
              {apiAvailable ? <Trans>Manage API keys</Trans> : <Trans>Add an API key</Trans>}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <DialogDescription className="text-center text-sm text-muted-foreground">
              <Trans>
                Sign in to let {name} write and run code for you. A browser window opens for sign-in — FlowPad never
                sees your password.
              </Trans>
            </DialogDescription>
            {statusReason && (
              <div
                data-testid="harness-status-reason"
                // The harness's own sentence, kept as evidence but off the
                // face of the panel: it instructs a terminal user to run
                // /login, which contradicts the button directly below.
                title={statusReason}
                className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-center text-xs text-amber-500"
              >
                {state === LoginState.Error ? (
                  <Trans>We couldn't confirm this sign-in: {statusReason}</Trans>
                ) : (
                  <Trans>{name} isn't signed in on this machine.</Trans>
                )}
              </div>
            )}
            <Button
              className="w-full gap-1.5"
              disabled={state === LoginState.SigningIn}
              onClick={() => void signIn()}
            >
              {state === LoginState.SigningIn && <Loader2 className="h-4 w-4 animate-spin" />}
              <Trans>Sign in to {name}</Trans>
            </Button>
          </div>
        )}
      </div>

      {/* Not installed: a footnote, not the offer.
          These two were full-width filled buttons and the ONLY thing on the panel, which made
          "install a CLI" look like the thing the user had come to do. They are a fallback for
          when the sign-in above cannot proceed yet, so they read as one quiet line: small,
          ghosted, side by side, under the thing that IS the offer. */}
      {state === InstallState.NotInstalled && (
        <div className="mt-4 flex flex-col items-center gap-2 border-t border-border/40 pt-3">
          <span className="text-xs text-muted-foreground">
            <Trans>{name} isn't installed on this computer yet.</Trans>
          </span>
          <div className="flex items-center justify-center gap-2">
            {installCommand && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                data-testid="harness-auto-install"
                onClick={tryAutoInstall}
              >
                <Terminal className="h-3.5 w-3.5" />
                <Trans>Try auto install</Trans>
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => openWikiModal(INSTALL_WIKI_PAGE)}
            >
              <Trans>Show setup guide</Trans>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * localStorage flag that records the user has already seen + dismissed the
 * startup harness-login gate. Once set, the gate never auto-opens again — the
 * footer warning remains the (click-driven) path back in. Restored from the
 * retired DesktopSetupModal so a user (or test harness) can opt out of the nag.
 */
const HARNESS_GATE_SEEN_KEY = 'llm-setup-modal-seen';

function harnessGateDismissed(): boolean {
  try {
    return localStorage.getItem(HARNESS_GATE_SEEN_KEY) === 'true';
  } catch {
    return false;
  }
}

export function markHarnessGateSeen(): void {
  try {
    localStorage.setItem(HARNESS_GATE_SEEN_KEY, 'true');
  } catch {
    /* private-mode / storage-disabled — nag stays, which is acceptable */
  }
}

/**
 * Startup gate: auto-open only when the DEFAULT assistant has nothing to pay for its runs, and
 * the user hasn't already dismissed the gate. The answer is the funding layer's — after one
 * status refresh, so a login the boot sweep has not probed yet is decided rather than guessed.
 * Other assistants' gaps are the footer warning's job, which opens this modal on click.
 */
function useHarnessLoginGate() {
  const primaryReady = usePrimaryContentReady();
  const decided = useRef(false);
  useEffect(() => {
    if (!primaryReady || decided.current || harnessGateDismissed()) return;
    let cancelled = false;
    void (async () => {
      try {
        const record = await statusService.refresh();
        const funding = await llmSourcesService.status();
        decided.current = true;
        const kind = record.default_harness;
        if (!cancelled && funding && !(kind && funding.resolved?.[kind])) openHarnessLoginModal();
      } catch {
        /* status unavailable — never block startup */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [primaryReady]);
}

const MAPPING_TIERS = [WorkerModelTier.SM, WorkerModelTier.MD, WorkerModelTier.LG] as const;
const isTier = (name: string) => (MAPPING_TIERS as readonly string[]).includes(name);
const TIER_LABEL: Record<string, string> = {
  [WorkerModelTier.SM]: 'Fast (sm)',
  [WorkerModelTier.MD]: 'Balanced (md)',
  [WorkerModelTier.LG]: 'Accurate (lg)',
};

/** One model-slug input (autocomplete via a shared datalist + free-text).
 *  Hoisted out of MappingView so it reconciles instead of remounting on every
 *  re-render; keyed by its persisted value at the call site so it refreshes only
 *  when that value actually changes. */
function MappingModelInput({
  name,
  value,
  listId,
  onCommit,
}: {
  name: string;
  value: string;
  listId: string;
  onCommit: (slug: string) => void;
}) {
  const { t } = useLingui();
  return (
    <Input
      defaultValue={value}
      list={listId}
      placeholder={isTier(name) ? t`Default` : t`model slug`}
      className="h-9"
      data-testid={`mapping-model-${name}`}
      onBlur={(e) => e.target.value.trim() !== value && onCommit(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** The Mapping window: edit the tier→model mapping per (harness, provider),
 *  layered over the code defaults, and add custom named options. */
function MappingView({ onBack }: { onBack: () => void }) {
  const { t } = useLingui();
  const [kind, setKind] = useState<string>(HARNESS_CAPABILITY_KINDS[0]);
  const { status: record } = useStatusRecord();
  const h = harnessStatus(record, kind);
  const providers = useMemo(
    () => [...(h?.key_providers.length ? h.key_providers : [LMApiProvider.OpenRouter]), LMApiProvider.FlowPad as string],
    [h],
  );
  const [provider, setProvider] = useState<string>(providers[0]);
  // Keep provider valid when the harness changes.
  useEffect(() => {
    if (!providers.includes(provider)) setProvider(providers[0]);
  }, [providers, provider]);

  // Live capability for the selected harness (for its model_map).
  const snapshot = capabilityManager.getSnapshot(kind);
  const capId = snapshot.capability?.id ?? null;
  const typeId = useMemo(() => (capId ? new TypeId(Capability.type, capId) : null), [capId]);
  const { data: capability } = useEntity<Capability>(typeId, { enabled: !!typeId, watch: true });
  const modelMap = useMemo(() => capability?.model_map ?? {}, [capability?.model_map]);
  const providerMap: Record<string, string> = modelMap[provider] ?? {};
  const customNames = Object.keys(providerMap).filter((n) => !isTier(n));

  // Model catalog for the picker (autocomplete + free-text).
  const [catalog, setCatalog] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    lmKeysService
      .listModels(provider as LMApiProvider)
      .then((m) => !cancelled && setCatalog(m))
      .catch(() => !cancelled && setCatalog([]));
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const [newName, setNewName] = useState('');
  const [newModel, setNewModel] = useState('');

  const writeProviderMap = useCallback(
    async (next: Record<string, string>) => {
      const full = { ...modelMap };
      if (Object.keys(next).length) full[provider] = next;
      else delete full[provider];
      await capabilityManager.setModelMap(kind, full);
    },
    [kind, provider, modelMap],
  );

  const setEntry = (name: string, slug: string) => {
    const next = { ...providerMap };
    if (slug.trim()) next[name] = slug.trim();
    else delete next[name];
    void writeProviderMap(next);
  };

  const listId = `mapping-catalog-${provider}`;

  return (
    <div
      style={{ animation: 'hlIn 260ms cubic-bezier(0.16,1,0.3,1) both' }}
      className="flex max-h-[80vh] flex-col overflow-y-auto"
    >
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
        <Trans>Back</Trans>
      </button>

      <DialogTitle className="text-lg font-semibold">
        <Trans>Model mapping</Trans>
      </DialogTitle>
      <DialogDescription className="mt-1 text-sm text-muted-foreground">
        <Trans>Choose which model each tier uses, or add your own — per assistant and provider.</Trans>
      </DialogDescription>

      <div className="mt-4 flex gap-2">
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="h-9 flex-1" data-testid="mapping-harness-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HARNESS_CAPABILITY_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {harnessStatus(record, k)?.label || workerOf(k)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger className="h-9 w-[130px]" data-testid="mapping-provider-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map((p) => (
              <SelectItem key={p} value={p}>
                {providerLabel(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <datalist id={listId}>
        {catalog.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </datalist>

      <div className="mt-4 flex flex-col gap-2">
        {MAPPING_TIERS.map((tier) => (
          <div key={tier} data-testid={`mapping-row-${tier}`} className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-sm text-muted-foreground">{TIER_LABEL[tier]}</span>
            <MappingModelInput
              key={providerMap[tier] ?? ''}
              name={tier}
              value={providerMap[tier] ?? ''}
              listId={listId}
              onCommit={(s) => setEntry(tier, s)}
            />
            {providerMap[tier] && (
              <button
                type="button"
                aria-label={t`Reset to default`}
                data-testid={`mapping-reset-${tier}`}
                className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setEntry(tier, '')}
              >
                <Trans>Reset</Trans>
              </button>
            )}
          </div>
        ))}

        {customNames.map((name) => (
          <div key={name} data-testid={`mapping-row-${name}`} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-sm font-medium">{name}</span>
            <MappingModelInput
              key={providerMap[name] ?? ''}
              name={name}
              value={providerMap[name] ?? ''}
              listId={listId}
              onCommit={(s) => setEntry(name, s)}
            />
            <button
              type="button"
              aria-label={t`Remove option`}
              data-testid={`mapping-delete-${name}`}
              className="shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => setEntry(name, '')}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      {/* Add a custom named option. */}
      <div className="mt-4 flex items-end gap-2 border-t border-border/60 pt-3">
        <div className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            <Trans>New option</Trans>
          </span>
          <div className="flex gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t`name (e.g. coding)`}
              className="h-9 w-32"
              data-testid="mapping-new-name"
            />
            <Input
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              list={listId}
              placeholder={t`model slug`}
              className="h-9"
              data-testid="mapping-new-model"
            />
          </div>
        </div>
        <Button
          disabled={!newName.trim() || !newModel.trim() || isTier(newName.trim())}
          data-testid="mapping-add"
          onClick={() => {
            setEntry(newName.trim(), newModel.trim());
            setNewName('');
            setNewModel('');
          }}
        >
          <Trans>Add</Trans>
        </Button>
      </div>
    </div>
  );
}

/** Single global mount (App.tsx). */
export function HarnessLoginModalRoot() {
  const { open, payload, setOpen } = useHarnessLoginStore();
  const [selected, setSelected] = useState<string | null>(null);
  // A row just finished connecting — confirmed IN PLACE rather than by closing, so the person
  // can see it landed before deciding whether they are done here or have more to connect.
  // `null` outside the banner's own moment; string is what it says.
  const [justConnected, setJustConnected] = useState<string | null>(null);
  const [defaultKind, setDefaultKind] = useState<string | null>(
    () => capabilityManager.getSnapshot('harness').resolvedKind ?? null,
  );
  // The configured LLM keys — fetched once here and shared by the keys section
  // (base layer) and every harness (consumer), so the whole modal agrees.
  const [keys, setKeys] = useState<LmApiKeySummary[]>([]);
  const refreshKeys = useCallback(async () => {
    try {
      setKeys(await lmKeysService.list());
    } catch {
      /* best-effort; leave the list empty on failure */
    }
  }, []);
  useHarnessLoginGate();

  /**
   * Make one assistant the default — what the "Default assistant" dropdown used to do, moved
   * onto the row it describes. Optimistic, and reverted from the manager's own snapshot on
   * failure: the tick is the only feedback, so it must not claim a change that did not land.
   */
  const makeDefault = useCallback(
    async (kind: string) => {
      const previous = defaultKind;
      setDefaultKind(kind);
      try {
        await capabilityManager.setReferenceKind(CapabilityKinds.Harness, kind);
        setDefaultKind(capabilityManager.getSnapshot(CapabilityKinds.Harness).resolvedKind ?? kind);
      } catch {
        setDefaultKind(previous);
      }
    },
    [defaultKind],
  );

  // Reset + refresh keys on a REAL re-open — the closed→open transition, not every render
  // while open. Reset means "back to the list" UNLESS the opener named a harness (the LLM
  // setup route does, because the user has already picked a vendor by then).
  //
  // The transition guard is load-bearing. `LlmSetupView` opens this modal from a mount effect,
  // so anything that re-mounts that view calls `open()` again — and this effect, keyed on
  // `open`/`payload`, then reset `selected` to null. Clicking a row selected it and the next
  // re-open silently threw the selection away: the button appeared to do nothing at all, with
  // no error anywhere. A redundant open() must never discard where the user has navigated to.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpen.current = false;
      setSelected(null);
      setJustConnected(null);
      return;
    }
    if (wasOpen.current) return;
    wasOpen.current = true;
    setSelected(payload?.kind ?? null);
    setJustConnected(null);
    void refreshKeys();
    // Re-check every harness on open (local probes, no money): the dialog that opened because a
    // login failed must not greet the user with the "Signed in" it last recorded.
    void statusService.refresh().catch(() => undefined);
  }, [open, payload, refreshKeys]);

  if (!open) return null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Dismissing the gate is a durable choice — record it so the startup
        // gate stops auto-opening (footer warning still reopens on demand).
        if (!next) markHarnessGateSeen();
        setOpen(next);
      }}
    >
      {/* Wide enough that every row fits on ONE line and the list needs no scrollbar:
          icon + name + status + button side by side. At 440px the button wrapped under
          the name and the list scrolled. */}
      <DialogContent className="sm:max-w-[620px]">
        <style>{`@keyframes hlIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
        {selected === 'mapping' ? (
          <MappingView onBack={() => setSelected(null)} />
        ) : selected === 'keys' ? (
          /* The keys form, reached from its own row rather than sitting expanded above the
             list. Same panel, same `onBack` as Mapping — one way in and out of a sub-view. */
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="mb-3 inline-flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
              <Trans>Back</Trans>
            </button>
            <DialogTitle className="mb-3 text-lg font-semibold">
              <Trans>LLM API keys</Trans>
            </DialogTitle>
            <LlmKeysSection keys={keys} refreshKeys={refreshKeys} />
          </div>
        ) : selected ? (
          <HarnessDetail
            kind={selected}
            onBack={() => setSelected(null)}
            onManageKeys={() => setSelected('keys')}
            onDone={() => {
              markHarnessGateSeen();
              setOpen(false);
            }}
          />
        ) : (
          <div className="flex flex-col">
            <DialogTitle className="text-lg font-semibold">
              <Trans>Assistants &amp; keys</Trans>
            </DialogTitle>

            {/* One line per thing that can pay for a call, FlowPad first: it is the only row
                that asks the user for nothing they do not already have, so reading order hands
                them that before it asks them to pick a vendor or find a key. */}
            <div className="mt-4 flex flex-col gap-2">
              {justConnected ? (
                <div
                  data-testid="harness-just-connected"
                  className="flex items-center justify-between gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm"
                >
                  <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                    <Check className="h-4 w-4" />
                    {justConnected}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="just-connected-keep-open"
                      onClick={() => setJustConnected(null)}
                    >
                      <Trans>Keep browsing</Trans>
                    </Button>
                    <Button
                      size="sm"
                      data-testid="just-connected-close"
                      onClick={() => {
                        markHarnessGateSeen();
                        setOpen(false);
                      }}
                    >
                      <Trans>Close</Trans>
                    </Button>
                  </div>
                </div>
              ) : null}
              <FlowpadListRow onConnected={() => setJustConnected(i18n._(msg`Signed in to FlowPad.`))} />

              {/* The one label the tick column needs.
                  With the "Default assistant" dropdown gone, which assistant is default is
                  carried by a small green check and nothing else — legible once you know what
                  it means, invisible until then. The heading says it, and earns its place
                  twice: it also separates the four ASSISTANTS from FlowPad above and the key
                  store below, which the flat list ran together even though only these four can
                  be a default. */}
              <div className="mt-3 flex items-center justify-between px-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Trans>Default assistant</Trans>
                </span>
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground/70">
                  <Check className="h-3 w-3" />
                  <Trans>pick one</Trans>
                </span>
              </div>

              {HARNESS_CAPABILITY_KINDS.map((kind) => (
                <HarnessListRow
                  key={kind}
                  kind={kind}
                  isDefault={kind === defaultKind}
                  onMakeDefault={() => void makeDefault(kind)}
                  onOpen={() => setSelected(kind)}
                />
              ))}

              <div className="mt-3" />
              <KeysListRow onOpen={() => setSelected('keys')} />
            </div>

            {/* Mapping stays a link, not a row: it configures which MODEL a funded harness
                calls, which is a different question from what pays for it. */}
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                data-testid="open-mapping"
                onClick={() => setSelected('mapping')}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Trans>Mapping</Trans>
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default HarnessLoginModalRoot;

import {
  Capability,
  capabilityManager,
  CapabilityKinds,
  copyToClipboard,
  HARNESS_CAPABILITY_KINDS,
  LMApiProvider,
  lmKeysService,
  TypeId,
  WorkerModelTier,
  type LmApiKeySummary,
  type LmApiKeyValidation,
} from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { notify } from '@src/notifications';
import { PROVIDER_META } from '@src/tabs/provider-meta';
import { AlertCircle, ArrowUpRight, Check, ChevronLeft, ChevronRight, KeyRound, Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { lucideByName } from '@src/lib/lucide-by-name';
import { openExternal } from '@src/lib/open-external';
import { openWikiModal } from '@src/components/wiki-tip/wiki-modal';
import { openHarnessLoginModal, useHarnessLoginStore } from './harness-login-store';

const INSTALL_WIKI_PAGE = 'Install a harness';

type Worker = 'claude' | 'codex' | 'copilot';
type Status = 'unavailable' | 'signedin' | 'awaiting' | 'busy' | 'signedout';
type AuthMode = 'device' | 'api';

const workerOf = (kind: string) => kind.split('.')[1] as Worker;

/** Providers each harness can authenticate against — the frontend mirror of the
 *  backend `ApiAuthSpec.supported_providers` (the backend also serves the same
 *  list via auth-status `details.supported_providers`). Keep in sync with the
 *  Python specs; the Select renders only these, so the modal offers only
 *  possible outcomes. */
const HARNESS_SUPPORTED_PROVIDERS: Record<Worker, LMApiProvider[]> = {
  // OpenRouter-only until the backend ApiAuthSpec routes non-OpenRouter providers
  // (base_env is provider-agnostic today). Keep in sync with the Python specs.
  claude: [LMApiProvider.OpenRouter],
  codex: [LMApiProvider.OpenRouter],
  copilot: [LMApiProvider.OpenRouter],
};

const PROVIDER_LABEL: Record<string, string> = {
  [LMApiProvider.OpenRouter]: 'OpenRouter',
  [LMApiProvider.Anthropic]: 'Anthropic',
  [LMApiProvider.OpenAI]: 'OpenAI',
};

/** Display name for a provider value, falling back to the raw value. */
const providerLabel = (provider: string) => PROVIDER_LABEL[provider] ?? provider;

/** Friendly, non-expert-facing extras that do NOT exist on the Capability
 *  entity. Name and icon are resolved registry-first in `useHarness`. */
const FRIENDLY: Record<Worker, { name: string; account: string }> = {
  claude: { name: 'Claude', account: 'Anthropic account' },
  codex: { name: 'Codex', account: 'ChatGPT account' },
  copilot: { name: 'Copilot', account: 'GitHub account' },
};

/** Shared per-harness state hook: resolves the live Capability entity, its
 *  simple status and presentation (name/icon/status text), plus the actions. */
function useHarness(kind: string, keys: LmApiKeySummary[]) {
  const { t } = useLingui();
  const snapshot = capabilityManager.getSnapshot(kind);
  const capabilityId = snapshot.capability?.id ?? null;
  const typeId = useMemo(() => (capabilityId ? new TypeId(Capability.type, capabilityId) : null), [capabilityId]);
  const { data: capability } = useEntity<Capability>(typeId, { enabled: !!typeId, watch: true });
  const [busy, setBusy] = useState(false);
  // Separate from `busy` so re-testing auth doesn't compute status to 'busy'.
  const [testing, setTesting] = useState(false);
  const [pasted, setPasted] = useState('');

  const worker = workerOf(kind);
  const supportedProviders = HARNESS_SUPPORTED_PROVIDERS[worker] ?? [];
  const defaultProvider = supportedProviders[0] ?? LMApiProvider.OpenRouter;
  // Providers this harness supports AND that have a configured key (from the
  // central keys section) — the only ones it can consume. api mode is unavailable
  // until at least one exists.
  const configuredProviders = supportedProviders.filter((p) =>
    keys.some((k) => k.configured && k.provider === (p as string)),
  );
  const apiAvailable = configuredProviders.length > 0;

  const authMode: AuthMode = (capability?.auth_mode as AuthMode) ?? 'device';
  // The active provider must be one that actually has a key. Only read where
  // apiAvailable (so configuredProviders is non-empty); the raw fallback just
  // keeps the badge label sensible when it isn't.
  const rawProvider = capability?.api_provider ?? defaultProvider;
  const activeProvider = configuredProviders.includes(rawProvider as LMApiProvider)
    ? rawProvider
    : (configuredProviders[0] ?? rawProvider);

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

  const installed = snapshot.checked && snapshot.available;
  const loginState = capability?.login_state ?? null;
  const status: Status = !installed
    ? 'unavailable'
    : loginState === 'authenticated'
      ? 'signedin'
      : loginState === 'awaiting_user'
        ? 'awaiting'
        : busy || loginState === 'starting'
          ? 'busy'
          : 'signedout';

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

  // Re-run the vendor's own auth check. The backend mirrors the result onto
  // login_state and broadcasts it, so the watched capability self-corrects (a
  // dead token flips the row to signed-out); the toast confirms the outcome.
  const testAuth = useCallback(async () => {
    if (!capability) return;
    setTesting(true);
    try {
      const r = await capability.authStatus();
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

  // Presentation resolves registry-first: the Capability entity's own
  // name/icon win, so a newly registered harness renders sensibly without a
  // frontend-table edit; PROVIDER_META/FRIENDLY only refine the known three.
  const meta = PROVIDER_META[worker];
  const name = FRIENDLY[worker]?.name || capability?.name || worker;
  const Icon = meta?.Icon ?? (capability?.icon ? lucideByName(capability.icon) : undefined);

  const authBadge =
    authMode === 'api'
      ? apiAvailable
        ? { label: 'LLM key', tone: 'emerald' as const }
        : { label: 'Key not set', tone: 'amber' as const }
      : { label: 'Device login', tone: 'sky' as const };

  return {
    capability,
    status,
    statusText: STATUS_TEXT[status],
    name,
    account: FRIENDLY[worker]?.account,
    Icon,
    iconClassName: meta?.iconClassName ?? '',
    pasted,
    setPasted,
    signIn,
    copyAndOpen,
    submitCode,
    testing,
    testAuth,
    // API-key auth (consumer view — keys are managed centrally)
    authMode,
    authBadge,
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

/** The device-vs-LLM-key indicator shown on rows and detail. */
function AuthBadge({
  badge,
  className,
  testId,
}: {
  badge: { label: string; tone: 'emerald' | 'amber' | 'sky' };
  className?: string;
  testId?: string;
}) {
  return (
    <Badge variant="outline" data-testid={testId} className={`gap-1 ${AUTH_BADGE_TONE[badge.tone]} ${className ?? ''}`}>
      <KeyRound className="h-3 w-3" />
      {badge.label}
    </Badge>
  );
}

const STATUS_TEXT: Record<Status, { label: string; dot: string; tone: string }> = {
  signedin: {
    label: 'Signed in',
    dot: 'bg-emerald-400 shadow-[0_0_7px] shadow-emerald-400/60',
    tone: 'text-emerald-500',
  },
  awaiting: {
    label: 'Waiting for you…',
    dot: 'bg-sky-400 shadow-[0_0_7px] shadow-sky-400/60 animate-pulse',
    tone: 'text-sky-500',
  },
  busy: {
    label: 'Starting…',
    dot: 'bg-sky-400 shadow-[0_0_7px] shadow-sky-400/60 animate-pulse',
    tone: 'text-sky-500',
  },
  signedout: {
    label: 'Not signed in',
    dot: 'bg-amber-400 shadow-[0_0_7px] shadow-amber-400/60',
    tone: 'text-amber-500',
  },
  unavailable: { label: 'Not installed', dot: 'bg-muted-foreground/40', tone: 'text-muted-foreground' },
};

/** Master list: one big, tappable row per assistant. */
function HarnessListRow({
  kind,
  onOpen,
  index,
  isDefault,
  keys,
}: {
  kind: string;
  onOpen: () => void;
  index: number;
  isDefault?: boolean;
  keys: LmApiKeySummary[];
}) {
  const { statusText: st, name, Icon, iconClassName, authBadge } = useHarness(kind, keys);
  const worker = workerOf(kind);

  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ animation: `hlIn 320ms cubic-bezier(0.16,1,0.3,1) ${index * 60}ms both` }}
      className="group flex w-full items-center gap-3.5 rounded-xl border border-border/70 bg-card/40 p-3.5 text-start transition-all hover:border-border hover:bg-accent/40"
    >
      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-border/60 bg-background/70">
        {Icon && <Icon className={`h-6 w-6 ${iconClassName}`} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[15px] font-semibold">
          {name}
          {isDefault && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]" data-testid={`harness-default-${worker}`}>
              <Trans>Default</Trans>
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
          <span className={`text-xs ${st.tone}`}>{st.label}</span>
        </div>
      </div>
      <AuthBadge badge={authBadge} testId={`harness-authmode-${worker}`} />
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
    </button>
  );
}

/** Central LLM-key management — the base layer. Add a key for any provider, see
 *  all configured keys, test validity, and delete. Shared across the modal;
 *  harnesses only consume these keys (they never enter them). */
function LlmKeysSection({ keys, refreshKeys }: { keys: LmApiKeySummary[]; refreshKeys: () => Promise<void> }) {
  const { t } = useLingui();
  const allProviders = Object.values(LMApiProvider);
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
                  <button
                    type="button"
                    aria-label={t`Delete key`}
                    data-testid={`keys-delete-${k.provider}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmDelete(k.provider)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
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
        onConfirm={() => {
          if (confirmDelete) void onDelete(confirmDelete);
          setConfirmDelete(null);
        }}
      />
    </div>
  );
}

/** Detail: one assistant, focused on the single next action. */
function HarnessDetail({ kind, onBack, keys }: { kind: string; onBack: () => void; keys: LmApiKeySummary[] }) {
  const { t } = useLingui();
  const {
    capability,
    status,
    statusText: st,
    name,
    account,
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
    authBadge,
    configuredProviders,
    activeProvider,
    apiAvailable,
    setAuthMode,
  } = useHarness(kind, keys);

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
          <AuthBadge badge={authBadge} testId="harness-detail-authmode" />
        </div>
      </div>

      {/* Sign-in method: device login vs a configured LLM key. The "LLM key"
          option is disabled until a key exists for a provider this harness
          supports (keys are managed in the LLM API keys section above). */}
      {status !== 'unavailable' && (
        <div className="mt-5 flex flex-col gap-3">
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
                <Trans>Using {providerLabel(activeProvider)} key</Trans>
              </span>
            </div>
          )}
        </div>
      )}

      {/* body per status — device sign-in flow (only relevant in device mode) */}
      <div className={`mt-6 ${authMode === 'api' ? 'hidden' : ''}`}>
        {status === 'unavailable' ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <DialogDescription className="text-sm text-muted-foreground">
              <Trans>
                {name} isn't installed on this computer yet. Follow the quick setup guide, then come back here to sign
                in.
              </Trans>
            </DialogDescription>
            <Button className="w-full" onClick={() => openWikiModal(INSTALL_WIKI_PAGE)}>
              <Trans>Show setup guide</Trans>
            </Button>
          </div>
        ) : status === 'signedin' ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-500">
              <Check className="h-4 w-4" />
              <Trans>You're signed in and ready to go.</Trans>
            </div>
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
              <Button variant="outline" className="flex-1" onClick={onBack}>
                <Trans>Done</Trans>
              </Button>
            </div>
          </div>
        ) : status === 'awaiting' ? (
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
        ) : (
          <div className="flex flex-col gap-4">
            <DialogDescription className="text-center text-sm text-muted-foreground">
              <Trans>
                Sign in with your {account} to let {name} write and run code for you. A browser window opens for sign-in
                — FlowPad never sees your password.
              </Trans>
            </DialogDescription>
            <Button className="w-full gap-1.5" disabled={status === 'busy'} onClick={() => void signIn()}>
              {status === 'busy' && <Loader2 className="h-4 w-4 animate-spin" />}
              <Trans>Sign in with {account}</Trans>
            </Button>
            {capability?.login_state === 'error' && capability?.login_message && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-center text-xs text-destructive">
                {capability.login_message}
              </div>
            )}
          </div>
        )}
      </div>
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
 * Startup gate: probe every assistant's sign-in state (cheap, no version run)
 * and auto-open only when NONE is signed in AND the user hasn't already
 * dismissed the gate. Partial states are covered by the footer warning, which
 * opens this modal on click.
 */
function useHarnessLoginGate() {
  useEffect(() => {
    if (harnessGateDismissed()) return;
    let cancelled = false;
    void (async () => {
      try {
        const results = await Promise.all(
          HARNESS_CAPABILITY_KINDS.map(async (kind) => {
            const snapshot = await capabilityManager.ensureChecked(kind);
            const capability = snapshot.capability;
            if (!capability) return null;
            try {
              return await capability.authStatus();
            } catch {
              return null;
            }
          }),
        );
        const anySignedIn = results.some((r) => r?.status === 'logged_in');
        if (!cancelled && !anySignedIn) openHarnessLoginModal();
      } catch {
        /* capabilities unavailable — never block startup */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}

/** The default assistant — persisted on the `harness` reference capability's
 *  reference_kind (same mechanism as CapabilitiesView). */
function DefaultHarnessSelect({ onChanged }: { onChanged: () => void }) {
  const [value, setValue] = useState<string>(
    () => capabilityManager.getSnapshot(CapabilityKinds.Harness).resolvedKind ?? HARNESS_CAPABILITY_KINDS[0],
  );
  const onChange = async (kind: string) => {
    setValue(kind);
    try {
      await capabilityManager.setReferenceKind(CapabilityKinds.Harness, kind);
      onChanged();
    } catch {
      /* revert on failure by re-reading the snapshot */
      setValue(capabilityManager.getSnapshot(CapabilityKinds.Harness).resolvedKind ?? kind);
    }
  };
  return (
    <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
      <span className="text-sm text-muted-foreground">
        <Trans>Default assistant</Trans>
      </span>
      <Select value={value} onValueChange={(k) => void onChange(k)}>
        <SelectTrigger className="h-8 w-[150px]" data-testid="default-harness-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {HARNESS_CAPABILITY_KINDS.map((kind) => (
            <SelectItem key={kind} value={kind}>
              {FRIENDLY[workerOf(kind)]?.name ?? workerOf(kind)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
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
  const worker = workerOf(kind);
  const providers = useMemo(() => HARNESS_SUPPORTED_PROVIDERS[worker] ?? [LMApiProvider.OpenRouter], [worker]);
  const [provider, setProvider] = useState<string>(providers[0]);
  // Keep provider valid when the harness changes.
  useEffect(() => {
    if (!providers.includes(provider as LMApiProvider)) setProvider(providers[0]);
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
                {FRIENDLY[workerOf(k)]?.name ?? workerOf(k)}
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
  const { open, setOpen } = useHarnessLoginStore();
  const [selected, setSelected] = useState<string | null>(null);
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

  // Reset to the list + refresh keys whenever the modal is reopened.
  useEffect(() => {
    if (!open) setSelected(null);
    else void refreshKeys();
  }, [open, refreshKeys]);

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
      <DialogContent className="sm:max-w-[440px]">
        <style>{`@keyframes hlIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
        {selected === 'mapping' ? (
          <MappingView onBack={() => setSelected(null)} />
        ) : selected ? (
          <HarnessDetail kind={selected} onBack={() => setSelected(null)} keys={keys} />
        ) : (
          <div className="flex max-h-[80vh] flex-col overflow-y-auto">
            <DialogTitle className="text-lg font-semibold">
              <Trans>Assistants &amp; keys</Trans>
            </DialogTitle>

            {/* Base layer: LLM API keys, configured once and shared. */}
            <div className="mt-3">
              <LlmKeysSection keys={keys} refreshKeys={refreshKeys} />
            </div>

            {/* Consumers: each harness picks device login or a configured key. */}
            <div className="mt-5 flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">
                <Trans>Harness setup</Trans>
              </span>
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
            <DefaultHarnessSelect
              onChanged={() => setDefaultKind(capabilityManager.getSnapshot('harness').resolvedKind ?? null)}
            />
            <div className="mt-3 flex flex-col gap-2.5">
              {HARNESS_CAPABILITY_KINDS.map((kind, i) => (
                <HarnessListRow
                  key={kind}
                  kind={kind}
                  index={i}
                  isDefault={kind === defaultKind}
                  onOpen={() => setSelected(kind)}
                  keys={keys}
                />
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default HarnessLoginModalRoot;

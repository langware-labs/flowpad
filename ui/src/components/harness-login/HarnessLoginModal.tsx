import {
  Capability,
  capabilityManager,
  copyToClipboard,
  HARNESS_CAPABILITY_KINDS,
  TypeId,
} from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { notify } from '@src/notifications';
import { PROVIDER_META } from '@src/tabs/provider-meta';
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { lucideByName } from '@src/lib/lucide-by-name';
import { openExternal } from '@src/lib/open-external';
import { openWikiModal } from '@src/components/wiki-tip/wiki-modal';
import { openHarnessLoginModal, useHarnessLoginStore } from './harness-login-store';

const INSTALL_WIKI_PAGE = 'Install a harness';

type Worker = 'claude' | 'codex' | 'copilot';
type Status = 'unavailable' | 'signedin' | 'awaiting' | 'busy' | 'signedout';

const workerOf = (kind: string) => kind.split('.')[1] as Worker;

/** Friendly, non-expert-facing extras that do NOT exist on the Capability
 *  entity. Name and icon are resolved registry-first in `useHarness`. */
const FRIENDLY: Record<Worker, { name: string; account: string }> = {
  claude: { name: 'Claude', account: 'Anthropic account' },
  codex: { name: 'Codex', account: 'ChatGPT account' },
  copilot: { name: 'Copilot', account: 'GitHub account' },
};

/** Shared per-harness state hook: resolves the live Capability entity, its
 *  simple status and presentation (name/icon/status text), plus the actions. */
function useHarness(kind: string) {
  const { t } = useLingui();
  const snapshot = capabilityManager.getSnapshot(kind);
  const capabilityId = snapshot.capability?.id ?? null;
  const typeId = useMemo(
    () => (capabilityId ? new TypeId(Capability.type, capabilityId) : null),
    [capabilityId],
  );
  const { data: capability } = useEntity<Capability>(typeId, { enabled: !!typeId, watch: true });
  const [busy, setBusy] = useState(false);
  const [pasted, setPasted] = useState('');

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
  const worker = workerOf(kind);
  const meta = PROVIDER_META[worker];
  const name = FRIENDLY[worker]?.name || capability?.name || worker;
  const Icon = meta?.Icon ?? (capability?.icon ? lucideByName(capability.icon) : undefined);

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
  };
}

const STATUS_TEXT: Record<Status, { label: string; dot: string; tone: string }> = {
  signedin: { label: 'Signed in', dot: 'bg-emerald-400 shadow-[0_0_7px] shadow-emerald-400/60', tone: 'text-emerald-500' },
  awaiting: { label: 'Waiting for you…', dot: 'bg-sky-400 shadow-[0_0_7px] shadow-sky-400/60 animate-pulse', tone: 'text-sky-500' },
  busy: { label: 'Starting…', dot: 'bg-sky-400 shadow-[0_0_7px] shadow-sky-400/60 animate-pulse', tone: 'text-sky-500' },
  signedout: { label: 'Not signed in', dot: 'bg-amber-400 shadow-[0_0_7px] shadow-amber-400/60', tone: 'text-amber-500' },
  unavailable: { label: 'Not installed', dot: 'bg-muted-foreground/40', tone: 'text-muted-foreground' },
};

/** Master list: one big, tappable row per assistant. */
function HarnessListRow({ kind, onOpen, index }: { kind: string; onOpen: () => void; index: number }) {
  const { statusText: st, name, Icon, iconClassName } = useHarness(kind);

  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ animation: `hlIn 320ms cubic-bezier(0.16,1,0.3,1) ${index * 60}ms both` }}
      className="group flex w-full items-center gap-3.5 rounded-xl border border-border/70 bg-card/40 p-3.5 text-left transition-all hover:border-border hover:bg-accent/40"
    >
      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-border/60 bg-background/70">
        {Icon && <Icon className={`h-6 w-6 ${iconClassName}`} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold">{name}</div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
          <span className={`text-xs ${st.tone}`}>{st.label}</span>
        </div>
      </div>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
    </button>
  );
}

/** Detail: one assistant, focused on the single next action. */
function HarnessDetail({ kind, onBack }: { kind: string; onBack: () => void }) {
  const { t } = useLingui();
  const { capability, status, statusText: st, name, account, Icon, iconClassName, pasted, setPasted, signIn, copyAndOpen, submitCode } =
    useHarness(kind);

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
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${st.dot}`} />
          <span className={`text-sm ${st.tone}`}>{st.label}</span>
        </div>
      </div>

      {/* body per status */}
      <div className="mt-6">
        {status === 'unavailable' ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <DialogDescription className="text-sm text-muted-foreground">
              <Trans>{name} isn't installed on this computer yet. Follow the quick setup guide, then come back here to sign in.</Trans>
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
            <Button variant="outline" className="w-full" onClick={onBack}>
              <Trans>Done</Trans>
            </Button>
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
              {capability?.login_code
                ? <Trans>2. Copy &amp; open the sign-in page</Trans>
                : <Trans>Open the sign-in page</Trans>}
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
                Sign in with your {account} to let {name} write and run code for
                you. A browser window opens for sign-in — FlowPad never sees your password.
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
 * Startup gate: probe every assistant's sign-in state (cheap, no version run)
 * and auto-open only when NONE is signed in. Partial states are covered by the
 * footer warning, which opens this modal on click.
 */
function useHarnessLoginGate() {
  useEffect(() => {
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

/** Single global mount (App.tsx). */
export function HarnessLoginModalRoot() {
  const { open, setOpen } = useHarnessLoginStore();
  const [selected, setSelected] = useState<string | null>(null);
  useHarnessLoginGate();

  // Reset to the list whenever the modal is reopened.
  useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);

  if (!open) return null;
  return (
    <Dialog open onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[420px]">
        <style>{`@keyframes hlIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
        {selected ? (
          <HarnessDetail kind={selected} onBack={() => setSelected(null)} />
        ) : (
          <div className="flex flex-col">
            <DialogTitle className="text-lg font-semibold">
              <Trans>Sign in to a coding assistant</Trans>
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              <Trans>Pick one to get started — it only takes a few seconds.</Trans>
            </DialogDescription>
            <div className="mt-4 flex flex-col gap-2.5">
              {HARNESS_CAPABILITY_KINDS.map((kind, i) => (
                <HarnessListRow key={kind} kind={kind} index={i} onOpen={() => setSelected(kind)} />
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default HarnessLoginModalRoot;

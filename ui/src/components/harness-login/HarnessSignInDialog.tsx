/**
 * Sign in to ONE assistant: the vendor's device-code flow, in a dialog of its own.
 *
 * Moved out of the Assistants & keys modal's per-harness detail view. Everything a sign-in
 * needs is here — the code, copy-and-open, the pasted code, cancel, a Test for a login that
 * is already there, and the install footnote for a CLI that is not — and nothing else is: what
 * FUNDS the harness is the LLM sources page's question, and the modal row's one pill answers it.
 */
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Capability, capabilityManager, copyToClipboard, InstallState, LoginState, TypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowUpRight, Check, KeyRound, Loader2, Terminal } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { openLlmSources } from '@src/components/llm-sources/llm-sources-pointer';
import { workerOf } from '@src/components/llm-sources/use-llm-sources';
import { harnessStatus, useStatusRecord } from '@src/components/status/use-status-record';
import { openWikiModal } from '@src/components/wiki-tip/wiki-modal';
import { ViewMode } from '@src/contexts/view-mode-context';
import { lucideByName } from '@src/lib/lucide-by-name';
import { openExternal } from '@src/lib/open-external';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { PROVIDER_META } from '@src/tabs/provider-meta';

import { useHarnessLoginStore } from './harness-login-store';
import { closeHarnessSignIn, useHarnessSignInStore } from './harness-sign-in-store';

const INSTALL_WIKI_PAGE = 'Install a harness';

/**
 * What the dialog's status line says, read straight off the status record: not installed, or
 * its login. `signing_in` also covers a sign-in this dialog just started and the backend has
 * not yet reported — the one state the dialog knows before the record does.
 */
type RowState = LoginState | InstallState.NotInstalled;

const AMBER = { dot: 'bg-amber-400 shadow-[0_0_7px] shadow-amber-400/60', tone: 'text-amber-500' };
const SKY = { dot: 'bg-sky-400 shadow-[0_0_7px] shadow-sky-400/60 animate-pulse', tone: 'text-sky-500' };
const MUTED = { dot: 'bg-muted-foreground/40', tone: 'text-muted-foreground' };
/** Module-level `msg` descriptors, resolved at render by `statusTextFor` — a `t` here would
 *  freeze the boot locale's English into the dialog for the rest of the session. */
const STATUS_TEXT: Record<RowState, { label: MessageDescriptor; dot: string; tone: string }> = {
  [LoginState.SignedIn]: {
    label: msg`Signed in`,
    dot: 'bg-emerald-400 shadow-[0_0_7px] shadow-emerald-400/60',
    tone: 'text-emerald-500',
  },
  [LoginState.SigningIn]: { label: msg`Signing in…`, ...SKY },
  [LoginState.SignedOut]: { label: msg`Not signed in`, ...AMBER },
  [LoginState.Error]: { label: msg`Sign-in failed`, ...AMBER },
  [LoginState.NotChecked]: { label: msg`Not checked yet`, ...MUTED },
  [LoginState.NA]: { label: msg`Uses a key`, ...MUTED },
  [InstallState.NotInstalled]: { label: msg`Not installed`, ...MUTED },
};

function statusTextFor(state: RowState): { label: string; dot: string; tone: string } {
  const entry = STATUS_TEXT[state];
  return { ...entry, label: i18n._(entry.label) };
}

/** The harness's status record, its live Capability row (code, URL), and the sign-in actions.
 *  Nothing here decides a fact. */
function useHarnessSignIn(kind: string) {
  const { t } = useLingui();
  const { status: record } = useStatusRecord();
  const h = harnessStatus(record, kind);
  const snapshot = capabilityManager.getSnapshot(kind);
  const capabilityId = snapshot.capability?.id ?? null;
  const typeId = useMemo(() => (capabilityId ? new TypeId(Capability.type, capabilityId) : null), [capabilityId]);
  const { data: capability } = useEntity<Capability>(typeId, { enabled: !!typeId, watch: true });

  const [busy, setBusy] = useState(false);
  // Separate from `busy` so re-testing auth doesn't read as a sign-in in flight.
  const [testing, setTesting] = useState(false);
  const [pasted, setPasted] = useState('');

  const supportsDevice = h?.has_device_login ?? true;

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

  return {
    capability,
    state,
    // The login's own sentence — the harness's refusal, or the probe's error — when it is not
    // signed in. Empty otherwise.
    statusReason:
      state === LoginState.SignedOut || state === LoginState.Error ? h?.login_message?.trim() || null : null,
    statusText: statusTextFor(state),
    name,
    worker,
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
    supportsDevice,
  };
}

export function HarnessSignInDialog({
  kind,
  onDone,
}: {
  kind: string;
  /** Dismiss the dialog. "Done" means the sign-in is finished, so the user goes back to what
   *  they were doing — never one level up into a list, which reads as a second popup. */
  onDone: () => void;
}) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const {
    capability,
    state,
    statusReason,
    statusText: st,
    name,
    worker,
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
    supportsDevice,
  } = useHarnessSignIn(kind);

  // Types the command at a prompt and submits it. Dismisses the dialog on the way out so the
  // terminal it just opened is what they see.
  const tryAutoInstall = useCallback(() => {
    if (!installCommand) return;
    onDone();
    void navigation.openNewShell({ startCommand: installCommand, viewMode: ViewMode.Advanced });
  }, [installCommand, navigation, onDone]);

  // A key-only harness has no account to sign into; its way forward is the keys section.
  const goToKeys = useCallback(() => {
    onDone();
    openLlmSources(navigation, 'keys');
  }, [navigation, onDone]);

  return (
    <div className="flex flex-col" data-testid={`harness-sign-in-${worker}`}>
      {/* identity */}
      <div className="flex flex-col items-center text-center">
        <div className="grid h-16 w-16 place-items-center rounded-2xl border border-border/60 bg-background/70">
          {Icon && <Icon className={`h-9 w-9 ${iconClassName}`} />}
        </div>
        <DialogTitle className="mt-3 text-xl font-semibold">{name}</DialogTitle>
        <div className="mt-1.5 flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${st.dot}`} />
          <span className={`text-sm ${st.tone}`}>{st.label}</span>
        </div>
      </div>

      <div className="mt-6">
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
             would do nothing. Its way forward is the keys section of LLM sources — taken there,
             not told where to go. */
          <div className="flex flex-col items-center gap-4 text-center">
            <DialogDescription className="text-sm text-muted-foreground">
              <Trans>{name} has no account to sign into — it runs on an LLM key or endpoint.</Trans>
            </DialogDescription>
            <Button className="w-full gap-1.5" onClick={goToKeys} data-testid="harness-manage-keys">
              <KeyRound className="h-4 w-4" />
              <Trans>Manage API keys</Trans>
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
                // The harness's own sentence, kept as evidence but off the face of the panel:
                // it instructs a terminal user to run /login, which contradicts the button below.
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
              data-testid="harness-sign-in"
              onClick={() => void signIn()}
            >
              {state === LoginState.SigningIn && <Loader2 className="h-4 w-4 animate-spin" />}
              <Trans>Sign in to {name}</Trans>
            </Button>
          </div>
        )}
      </div>

      {/* Not installed: a footnote under the offer, not the offer. */}
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

/** Mounted once, beside `HarnessLoginModalRoot`. */
export function HarnessSignInDialogRoot() {
  const { open, payload } = useHarnessSignInStore();
  const closeModal = useHarnessLoginStore((s) => s.setOpen);
  // Done closes this dialog AND the Assistants & keys modal under it, if it is up: the sign-in
  // is finished, so the person goes back to what they were doing.
  const onDone = useCallback(() => {
    closeHarnessSignIn();
    closeModal(false);
  }, [closeModal]);
  if (!open || !payload?.kind) return null;
  return (
    <Dialog open onOpenChange={(next) => !next && closeHarnessSignIn()}>
      <DialogContent className="sm:max-w-[440px]">
        <HarnessSignInDialog kind={payload.kind} onDone={onDone} />
      </DialogContent>
    </Dialog>
  );
}

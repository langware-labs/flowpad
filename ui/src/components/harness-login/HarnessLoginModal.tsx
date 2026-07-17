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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { notify } from '@src/notifications';
import { BookOpen, CheckCircle2, ExternalLink, KeyRound, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { openExternal } from '@src/lib/open-external';
import { lucideByName } from '@src/lib/lucide-by-name';
import { openWikiModal } from '@src/components/wiki-tip/wiki-modal';
import { openHarnessLoginModal, useHarnessLoginStore } from './harness-login-store';

const INSTALL_WIKI_PAGE = 'Install a harness';

/** One harness row: status chip + the login flow driven entirely by the
 *  Capability entity's broadcast login_* fields (no polling). */
function HarnessRow({ kind }: { kind: string }) {
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
  const state = capability?.login_state ?? null;
  const name = capability?.name ?? snapshot.capability?.name ?? kind;
  const Icon = lucideByName(capability?.icon);

  // One derived status the chip and body both switch on (installed + the
  // login state machine), so the two never drift.
  const rowStatus: 'unavailable' | 'authenticated' | 'awaiting' | 'busy' | 'loggedout' = !installed
    ? 'unavailable'
    : state === 'authenticated'
      ? 'authenticated'
      : state === 'awaiting_user'
        ? 'awaiting'
        : busy || state === 'starting'
          ? 'busy'
          : 'loggedout';

  const startLogin = useCallback(async () => {
    if (!capability) return;
    setBusy(true);
    try {
      await capability.deviceLogin();
    } catch {
      notify.error({ title: t`Could not start the login flow`, durationMs: 4000 });
    } finally {
      setBusy(false);
    }
  }, [capability, t]);

  // Copy inside the user gesture (so paste works on the vendor page), then open.
  const copyAndOpen = useCallback(async () => {
    if (!capability?.login_url) return;
    if (capability.login_code) {
      try {
        await copyToClipboard(capability.login_code);
        notify.success({ title: t`Code copied — paste it on the vendor page`, durationMs: 2500 });
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

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" />
        <span className="font-medium">{name}</span>
        <span className="ml-auto text-xs">
          {rowStatus === 'unavailable' ? (
            <span className="text-muted-foreground"><Trans>Not available</Trans></span>
          ) : rowStatus === 'authenticated' ? (
            <span className="flex items-center gap-1 text-emerald-500">
              <CheckCircle2 className="h-3.5 w-3.5" />
              <Trans>Available</Trans>
            </span>
          ) : (
            <span className="text-amber-500"><Trans>Login required</Trans></span>
          )}
        </span>
      </div>

      {rowStatus === 'unavailable' ? (
        <Button size="sm" variant="outline" onClick={() => openWikiModal(INSTALL_WIKI_PAGE)}>
          <BookOpen className="mr-1.5 h-3.5 w-3.5" />
          <Trans>How to install</Trans>
        </Button>
      ) : rowStatus === 'awaiting' ? (
        <div className="flex flex-col gap-2">
          {capability?.login_code && (
            <div className="flex items-center justify-center rounded-md border border-border bg-muted/40 px-4 py-2">
              <span className="select-all font-mono text-xl tracking-widest">{capability.login_code}</span>
            </div>
          )}
          <Button size="sm" onClick={() => void copyAndOpen()}>
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            {capability?.login_code ? <Trans>Copy code &amp; open sign-in page</Trans> : <Trans>Open sign-in page</Trans>}
          </Button>
          {capability?.login_accepts_code && (
            <div className="flex items-center gap-2">
              <Input
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                placeholder={t`Paste the code shown in your browser`}
                className="h-8 text-xs"
              />
              <Button size="sm" variant="outline" disabled={!pasted.trim()} onClick={() => void submitCode()}>
                <Trans>Submit</Trans>
              </Button>
            </div>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <Trans>Waiting for authorization…</Trans>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-xs"
              onClick={() => void capability?.cancelDeviceLogin()}
            >
              <Trans>Cancel</Trans>
            </Button>
          </div>
        </div>
      ) : rowStatus === 'authenticated' ? (
        <div className="text-xs text-muted-foreground">
          {capability?.login_message}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Button size="sm" disabled={rowStatus === 'busy'} onClick={() => void startLogin()}>
            {rowStatus === 'busy' ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <KeyRound className="mr-1.5 h-3.5 w-3.5" />
            )}
            <Trans>Login</Trans>
          </Button>
          {state === 'error' && capability?.login_message && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {capability.login_message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Startup gate: once capabilities are loaded, probe every harness's login
 * state (cheap `auth-status`, no version run). Auto-open the modal only when
 * ZERO harnesses are authenticated — partial states are covered by the
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
        const anyAuthenticated = results.some((r) => r?.status === 'logged_in');
        if (!cancelled && !anyAuthenticated) openHarnessLoginModal();
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
  useHarnessLoginGate();

  if (!open) return null;
  return (
    <Dialog open onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle><Trans>Harness login required</Trans></DialogTitle>
          <DialogDescription>
            <Trans>
              Agents run through a coding-agent CLI (a “harness”). Sign in to at least one below —
              the sign-in happens in your browser; FlowPad never sees your credentials.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {HARNESS_CAPABILITY_KINDS.map((kind) => (
            <HarnessRow key={kind} kind={kind} />
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            <Trans>Close</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default HarnessLoginModalRoot;

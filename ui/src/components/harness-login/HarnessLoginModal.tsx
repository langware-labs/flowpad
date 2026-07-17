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
import { ArrowUpRight, BookOpen, Check, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { openExternal } from '@src/lib/open-external';
import { lucideByName } from '@src/lib/lucide-by-name';
import { openWikiModal } from '@src/components/wiki-tip/wiki-modal';
import { openHarnessLoginModal, useHarnessLoginStore } from './harness-login-store';

const INSTALL_WIKI_PAGE = 'Install a harness';

/** Per-vendor presentation metadata (provider line + the sign-in destination
 *  label). Name/icon still come from the backend capability. */
const VENDOR_META: Record<string, { provider: string; account: string; opensAt: string }> = {
  'harness.claude.cli': { provider: 'Anthropic', account: 'claude.ai', opensAt: 'claude.com' },
  'harness.codex.cli': { provider: 'OpenAI', account: 'ChatGPT', opensAt: 'openai.com' },
  'harness.copilot.cli': { provider: 'GitHub', account: 'Copilot', opensAt: 'github.com' },
};

type RowStatus = 'unavailable' | 'authenticated' | 'awaiting' | 'busy' | 'loggedout';

const STATUS_LED: Record<RowStatus, string> = {
  authenticated: 'bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60',
  awaiting: 'bg-sky-400 shadow-[0_0_8px] shadow-sky-400/60 animate-pulse',
  busy: 'bg-sky-400 shadow-[0_0_8px] shadow-sky-400/60 animate-pulse',
  loggedout: 'bg-amber-400 shadow-[0_0_8px] shadow-amber-400/60',
  unavailable: 'bg-muted-foreground/40',
};

/** One harness row — a terminal "device" card driven entirely by the
 *  Capability entity's broadcast login_* fields (no polling). */
function HarnessRow({ kind, index }: { kind: string; index: number }) {
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
  const meta = VENDOR_META[kind];

  // One derived status the LED, label, and body all switch on, so they can't
  // drift.
  const rowStatus: RowStatus = !installed
    ? 'unavailable'
    : state === 'authenticated'
      ? 'authenticated'
      : state === 'awaiting_user'
        ? 'awaiting'
        : busy || state === 'starting'
          ? 'busy'
          : 'loggedout';

  const statusLabel = {
    unavailable: t`Not installed`,
    authenticated: t`Connected`,
    awaiting: t`Waiting…`,
    busy: t`Starting…`,
    loggedout: t`Sign-in needed`,
  }[rowStatus];

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
        notify.success({ title: t`Code copied — paste it on the sign-in page`, durationMs: 2500 });
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
    <div
      className="group relative overflow-hidden rounded-lg border border-border/80 bg-card/40 transition-colors hover:border-border"
      style={{ animation: `harnessRowIn 380ms cubic-bezier(0.16,1,0.3,1) ${index * 70}ms both` }}
    >
      {/* left status spine */}
      <div
        className={`absolute inset-y-0 left-0 w-[3px] ${
          rowStatus === 'authenticated'
            ? 'bg-emerald-400/70'
            : rowStatus === 'unavailable'
              ? 'bg-muted-foreground/25'
              : 'bg-amber-400/70'
        }`}
      />

      <div className="flex items-center gap-3 px-4 py-3 pl-5">
        {/* prompt-glyph identity tile */}
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-border/70 bg-background/60 text-foreground/80">
          <Icon className="h-[18px] w-[18px]" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-mono text-[15px] font-semibold tracking-tight">{name}</span>
            {meta && (
              <span className="hidden text-[11px] text-muted-foreground/70 sm:inline">
                {meta.provider} · {meta.account}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_LED[rowStatus]}`} />
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {statusLabel}
            </span>
          </div>
        </div>

        {/* right-side action — compact, never full-width */}
        <div className="shrink-0">
          {rowStatus === 'unavailable' ? (
            <button
              type="button"
              onClick={() => openWikiModal(INSTALL_WIKI_PAGE)}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <BookOpen className="h-3.5 w-3.5" />
              <Trans>Install</Trans>
            </button>
          ) : rowStatus === 'authenticated' ? (
            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-emerald-500">
              <Check className="h-3.5 w-3.5" />
              <Trans>Ready</Trans>
            </span>
          ) : rowStatus === 'awaiting' ? (
            <button
              type="button"
              onClick={() => void capability?.cancelDeviceLogin()}
              className="rounded-md px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Trans>Cancel</Trans>
            </button>
          ) : (
            <button
              type="button"
              disabled={rowStatus === 'busy'}
              onClick={() => void startLogin()}
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3.5 py-1.5 font-mono text-[12px] font-semibold text-background shadow-sm transition-all hover:bg-foreground/90 hover:shadow active:scale-[0.97] disabled:opacity-60"
            >
              {rowStatus === 'busy' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <Trans>Sign in</Trans>
            </button>
          )}
        </div>
      </div>

      {/* awaiting-user expansion: code + open + paste */}
      {rowStatus === 'awaiting' && (
        <div className="border-t border-border/60 bg-background/40 px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {capability?.login_code && (
              <div className="flex items-center gap-0.5 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2">
                {capability.login_code.split('').map((ch, i) => (
                  <span
                    key={i}
                    className={
                      ch === '-'
                        ? 'px-0.5 font-mono text-lg text-muted-foreground/50'
                        : 'select-all font-mono text-lg font-semibold tracking-wide tabular-nums'
                    }
                  >
                    {ch}
                  </span>
                ))}
              </div>
            )}
            <Button
              size="sm"
              onClick={() => void copyAndOpen()}
              className="h-9 gap-1.5 bg-foreground font-mono text-[12px] font-semibold text-background hover:bg-foreground/90"
            >
              {capability?.login_code ? <Trans>Copy code &amp; open</Trans> : <Trans>Open sign-in</Trans>}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Button>
            {meta && (
              <span className="font-mono text-[10px] text-muted-foreground/60">→ {meta.opensAt}</span>
            )}
          </div>

          {capability?.login_accepts_code && (
            <div className="mt-2.5 flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70">
                <Trans>then paste code</Trans>
              </span>
              <Input
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submitCode()}
                placeholder={t`code from browser`}
                className="h-8 max-w-[180px] font-mono text-xs"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={!pasted.trim()}
                onClick={() => void submitCode()}
                className="h-8 font-mono text-[11px]"
              >
                <Trans>Submit</Trans>
              </Button>
            </div>
          )}

          {rowStatus === 'awaiting' && (
            <div className="mt-2.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/70">
              <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-sky-400" />
              <Trans>waiting for authorization in your browser…</Trans>
            </div>
          )}
        </div>
      )}

      {/* error line */}
      {rowStatus === 'loggedout' && state === 'error' && capability?.login_message && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-5 py-2 font-mono text-[11px] text-destructive">
          {capability.login_message}
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
      <DialogContent className="gap-0 overflow-hidden border-border/80 p-0 sm:max-w-[440px]">
        <style>{`@keyframes harnessRowIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>

        {/* header — a terminal title bar */}
        <div className="relative border-b border-border/70 bg-gradient-to-b from-muted/40 to-transparent px-5 pb-4 pt-5">
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/70">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shadow-[0_0_8px] shadow-amber-400/60" />
            <Trans>authentication required</Trans>
          </div>
          <DialogTitle className="mt-2 font-mono text-lg font-semibold tracking-tight text-foreground">
            <Trans>Connect a harness</Trans>
          </DialogTitle>
          <DialogDescription className="mt-1 pr-6 text-[13px] leading-snug text-muted-foreground">
            <Trans>
              Agents run through a coding-agent CLI. Sign in to at least one — it happens in your
              browser and FlowPad never sees your credentials.
            </Trans>
          </DialogDescription>
        </div>

        {/* rows */}
        <div className="flex flex-col gap-2.5 p-4">
          {HARNESS_CAPABILITY_KINDS.map((kind, i) => (
            <HarnessRow key={kind} kind={kind} index={i} />
          ))}
        </div>

        {/* footer */}
        <div className="flex items-center justify-between border-t border-border/70 px-5 py-3">
          <span className="font-mono text-[10px] text-muted-foreground/60">
            <Trans>one is enough to get started</Trans>
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md px-3 py-1.5 font-mono text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Trans>Dismiss</Trans>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default HarnessLoginModalRoot;

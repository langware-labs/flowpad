import { Trans, useLingui } from '@lingui/react/macro';
import type { BrowserStatus, SessionBrowser } from '@sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Dialog, DialogContent, DialogTitle } from '@src/components/ui/dialog';
import { useProjectLocation } from '@src/hooks/use-project-location';
import { ProfileLabel } from '@src/components/links/BrowserProfileItems';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { Globe, Check, Chrome } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/** Claude in Chrome on the Chrome Web Store. */
const EXTENSION_URL = 'https://chromewebstore.google.com/detail/claude/fcoeoabgfenejglbffodgkkbkcdhcgfn';
const POLL_MS = 5000;
/** A browser call this recent counts as "in use". */
const LIVE_MS = 15000;

type ExtensionState = 'not_installed' | 'not_connected' | 'connected';

/** What the chip knows about the extension. Connected is only proven by a session's own
 *  browser call; the install flag is Claude Code's cached hint. */
export function extensionState(s: BrowserStatus): ExtensionState {
  const ok = !s.last_use?.failed;
  if (ok && s.last_use?.family === 'extension') return 'connected';
  if (!s.extension.installed) return 'not_installed';
  return ok && s.effective === 'extension' ? 'connected' : 'not_connected';
}

/** The profile the extension lives in, by its real name; null when none is known. */
export function extensionProfile(s: BrowserStatus): string | null {
  const hit = s.extension.profiles?.find((p) => p.installed);
  return hit ? hit.name : null;
}

export type ChipState = 'idle' | 'live' | 'dropped';

export function chipState(s: BrowserStatus, now: number): ChipState {
  const use = s.last_use;
  if (!use || use.family !== (s.effective === 'extension' ? 'extension' : 'agent')) return 'idle';
  if (use.failed) return 'dropped';
  const at = use.at ? Date.parse(use.at) : NaN;
  return Number.isFinite(at) && now - at < LIVE_MS ? 'live' : 'idle';
}

function useBrowserStatus() {
  const { project } = useProjectLocation();
  const { currentDock } = useDockNavigation();
  const processId =
    currentDock && DockPointer.isSessionView(currentDock.viewType) && DockPointer.isAgenticProcessPointer(currentDock.pointer)
      ? DockPointer.extractAgenticProcessId(currentDock.pointer!)
      : undefined;
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const refresh = useCallback(async () => {
    if (!project) return setStatus(null);
    try {
      setStatus(await project.browserStatus(processId));
    } catch {
      setStatus(null);
    }
  }, [project, processId]);
  useEffect(() => {
    void refresh();
    // A hidden tab shows nothing: skip its polls, catch up when it is shown again.
    const tick = () => {
      if (!document.hidden) void refresh();
    };
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh]);
  return { project, processId, status, refresh };
}

export function Row({
  icon,
  name,
  note,
  tone,
  selected,
  disabled,
  action,
  onSelect,
  testId,
  profile,
}: {
  profile?: React.ReactNode;
  icon: React.ReactNode;
  name: React.ReactNode;
  note: React.ReactNode;
  tone: 'ok' | 'warn' | 'muted';
  selected?: boolean;
  disabled?: boolean;
  action?: React.ReactNode;
  onSelect?: () => void;
  testId: string;
}) {
  return (
    <div
      data-testid={testId}
      data-selected={selected || undefined}
      className={cn('flex items-center gap-2 border-t px-3 py-1.5 text-xs', selected && 'bg-accent')}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        className={cn('flex min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap text-start', disabled && 'opacity-55')}
      >
        {icon}
        <span className="font-semibold">{name}</span>
        <span
          className={cn(
            'truncate text-[11px]',
            tone === 'ok' && 'text-green-600 dark:text-green-400',
            tone === 'warn' && 'text-amber-600 dark:text-amber-400',
            tone === 'muted' && 'text-muted-foreground',
          )}
        >
          · {note}
        </span>
      </button>
      {profile && (
        <span className="shrink-0 text-[11px] text-muted-foreground" data-testid={`${testId}-profile`}>
          {profile}
        </span>
      )}
      {action}
      {selected && <Check className="h-3.5 w-3.5 text-primary" />}
    </div>
  );
}

const EXT_ROW: Record<ExtensionState, { note: React.ReactNode; tone: 'ok' | 'warn' | 'muted' }> = {
  connected: { note: <Trans>connected</Trans>, tone: 'ok' },
  not_connected: { note: <Trans>not connected</Trans>, tone: 'warn' },
  not_installed: { note: <Trans>not installed</Trans>, tone: 'muted' },
};

export const smallBtn = 'rounded px-2 py-0.5 text-[11px] border hover:bg-accent';
const primaryBtn = 'rounded px-2 py-0.5 text-[11px] bg-primary text-primary-foreground';

/** Add browser: pick a kind → connect checks → done. v1 kinds: the extension (your Chrome)
 *  and the agent browser (always there); the rest are shown, not offered yet. */
function AddBrowserDialog({
  open,
  onOpenChange,
  status,
  onRefresh,
  onUse,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  status: BrowserStatus;
  onRefresh: () => Promise<void>;
  onUse: (b: SessionBrowser) => void;
}) {
  const [step, setStep] = useState<'kind' | 'connect' | 'done'>('kind');
  useEffect(() => {
    if (open) setStep('kind');
  }, [open]);
  const ext = extensionState(status);
  const check = (label: React.ReactNode, ok: boolean, waiting: React.ReactNode) => (
    <div className="flex items-center gap-2 py-1 text-xs">
      <span className={ok ? 'text-green-500' : 'text-amber-500'}>●</span>
      {label}
      <span className={cn('ms-auto text-[11px]', ok ? 'text-green-500' : 'text-amber-500')}>{ok ? '✓' : waiting}</span>
    </div>
  );
  const kind = (icon: React.ReactNode, name: React.ReactNode, note: React.ReactNode, onClick?: () => void, testId?: string) => (
    <button
      type="button"
      data-testid={testId}
      disabled={!onClick}
      onClick={onClick}
      className="mt-1.5 flex w-full items-center gap-2 whitespace-nowrap rounded-md border px-2.5 py-2 text-xs hover:bg-accent disabled:opacity-50"
    >
      {icon}
      <span className="font-semibold">{name}</span>
      <span className="text-[11px] text-muted-foreground">· {note}</span>
    </button>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[380px] p-4" data-testid="add-browser-dialog">
        <DialogTitle className="text-sm">
          <Trans>Add browser</Trans>
        </DialogTitle>
        {step === 'kind' && (
          <div>
            {kind(<Chrome className="h-3.5 w-3.5" />, <Trans>Your Chrome</Trans>, <Trans>extension</Trans>, () => setStep('connect'), 'add-browser-extension')}
            {kind(<Globe className="h-3.5 w-3.5" />, <Trans>Agent browser</Trans>, <Trans>always ready</Trans>, () => setStep('done'), 'add-browser-agent')}
            {kind(<Chrome className="h-3.5 w-3.5" />, <Trans>Edge / Brave / Arc</Trans>, <Trans>soon</Trans>)}
          </div>
        )}
        {step === 'connect' && (
          <div data-testid="add-browser-checks">
            <div className="mb-1 text-[11px] text-muted-foreground">
              <Trans>Chrome profiles on this computer</Trans>
            </div>
            {(status.extension.profiles ?? []).map((p) => (
              <div key={`${p.browser}/${p.name}`} className="flex items-center gap-2 py-1 text-xs" data-testid="add-browser-profile">
                <Chrome className="h-3.5 w-3.5" />
                <ProfileLabel profile={p} />
                <span className={cn('ms-auto text-[11px]', p.installed ? 'text-green-500' : 'text-muted-foreground')}>
                  {p.installed ? <Trans>extension ✓</Trans> : <Trans>no extension</Trans>}
                </span>
              </div>
            ))}
            {status.extension.profiles_denied && (
              <div className="py-1 text-xs text-muted-foreground" data-testid="add-browser-profile-denied">
                <Trans>Profile not found</Trans>
              </div>
            )}
            {check(<Trans>Extension installed</Trans>, ext !== 'not_installed', <Trans>missing</Trans>)}
            {check(<Trans>Connected</Trans>, ext === 'connected', <Trans>on first browser step</Trans>)}
            <div className="mt-2 flex gap-1.5">
              <a className={smallBtn} href={EXTENSION_URL} target="_blank" rel="noreferrer">
                <Trans>Open Chrome Web Store</Trans>
              </a>
              <button type="button" className={smallBtn} onClick={() => void onRefresh()}>
                <Trans>Check again</Trans>
              </button>
            </div>
            <div className="mt-3 flex justify-end gap-1.5">
              <button type="button" className={smallBtn} onClick={() => setStep('kind')}>
                <Trans>Back</Trans>
              </button>
              <button
                type="button"
                className={primaryBtn}
                disabled={ext === 'not_installed'}
                onClick={() => {
                  onUse('extension');
                  setStep('done');
                }}
                data-testid="add-browser-use-extension"
              >
                <Trans>Use it</Trans>
              </button>
            </div>
          </div>
        )}
        {step === 'done' && (
          <div className="flex items-center justify-between text-xs" data-testid="add-browser-done">
            <Trans>Added</Trans>
            <button type="button" className={primaryBtn} onClick={() => onOpenChange(false)}>
              <Trans>Done</Trans>
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Footer chip: the browser this session (or, outside a session, the project) uses,
 *  whether it is available, and a picker. The setting lives in the project manifest;
 *  a session picks it up at its next launch. */
export function BrowserChip() {
  const { t } = useLingui();
  const { project, status, refresh } = useBrowserStatus();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  if (!project || !status) return null;

  const ext = extensionState(status);
  const profileName = extensionProfile(status);
  const state = chipState(status, Date.now());
  const usingExtension = status.effective === 'extension';
  const choose = async (browser: SessionBrowser) => {
    await project.setBrowser(browser);
    await refresh();
  };
  const label = usingExtension ? t`Your Chrome` : t`Agent browser`;
  const Icon = usingExtension ? Chrome : Globe;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="footer-browser-chip"
            data-state={state}
            data-browser={status.effective}
            aria-label={label}
            title={status.last_use?.url ? `${label} · ${status.last_use.url}` : label}
            className={cn(
              'relative flex shrink-0 items-center gap-1 rounded-sm border border-transparent px-1.5 text-[10px] hover:bg-accent',
              state === 'dropped' && 'border-red-900 text-red-400',
            )}
          >
            <span className="relative inline-flex">
              <Icon className="h-3 w-3" />
              {state !== 'idle' && (
                <span
                  className={cn(
                    'absolute -end-1 -top-0.5 h-1.5 w-1.5 rounded-full',
                    state === 'live' ? 'bg-green-500' : 'bg-red-500',
                  )}
                />
              )}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0" data-testid="browser-picker">
          <div className="px-3 py-2 text-xs font-semibold">
            <Trans>Browser</Trans>
          </div>
          <Row
            testId="browser-row-agent"
            icon={<Globe className="h-3.5 w-3.5" />}
            name={<Trans>Agent browser</Trans>}
            note={status.agent.up ? <Trans>running</Trans> : <Trans>ready</Trans>}
            tone="ok"
            profile={<Trans>Profile: not available</Trans>}
            selected={!usingExtension}
            onSelect={() => void choose('agent')}
          />
          {status.supports_extension && (
            <Row
              testId="browser-row-extension"
              icon={<Chrome className="h-3.5 w-3.5" />}
              name={<Trans>Your Chrome</Trans>}
              note={EXT_ROW[ext].note}
              tone={EXT_ROW[ext].tone}
              profile={profileName ? <Trans>Profile: {profileName}</Trans> : <Trans>Profile not found</Trans>}
              selected={usingExtension}
              disabled={ext === 'not_installed'}
              onSelect={() => void choose('extension')}
              action={
                ext === 'not_installed' ? (
                  <a className={smallBtn} href={EXTENSION_URL} target="_blank" rel="noreferrer">
                    <Trans>Install</Trans>
                  </a>
                ) : ext === 'not_connected' ? (
                  <button type="button" className={primaryBtn} onClick={() => void refresh()}>
                    <Trans>Reconnect</Trans>
                  </button>
                ) : null
              }
            />
          )}
          {state === 'dropped' && usingExtension && (
            <div className="flex gap-1.5 border-t px-3 py-1.5" data-testid="browser-dropped">
              <button type="button" className={smallBtn} onClick={() => void choose('agent')}>
                <Trans>Use Agent browser</Trans>
              </button>
            </div>
          )}
          <button
            type="button"
            data-testid="browser-add"
            onClick={() => {
              setOpen(false);
              setAdding(true);
            }}
            className="flex w-full border-t px-3 py-1.5 text-xs text-primary hover:bg-accent"
          >
            <Trans>+ Add browser</Trans>
          </button>
        </PopoverContent>
      </Popover>
      <AddBrowserDialog open={adding} onOpenChange={setAdding} status={status} onRefresh={refresh} onUse={(b) => void choose(b)} />
    </>
  );
}

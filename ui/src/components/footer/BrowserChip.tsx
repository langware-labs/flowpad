import { Trans, useLingui } from '@lingui/react/macro';
import type { BrowserDriverInfo, BrowserDriverState, BrowserKindInfo, BrowserStatus, SessionBrowser } from '@sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Dialog, DialogContent, DialogTitle } from '@src/components/ui/dialog';
import { useProjectLocation } from '@src/hooks/use-project-location';
import { ProfileLabel } from '@src/components/links/BrowserProfileItems';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { lucideByName } from '@src/lib/lucide-by-name';
import { formatDay } from '@src/utils/format-time-ago';
import { Check } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/** The driver in use. */
export function effectiveDriver(s: BrowserStatus): BrowserDriverInfo | undefined {
  return s.drivers.find((d) => d.name === s.effective);
}
const POLL_MS = 5000;
/** A browser call this recent counts as "in use". */
const LIVE_MS = 15000;

/** The profile the extension lives in, by its real name; null when none is known. */
export function extensionProfile(s: BrowserStatus): string | null {
  const hit = s.extension.profiles?.find((p) => p.installed);
  return hit ? hit.name : null;
}

export type ChipState = 'idle' | 'live' | 'dropped';

export function chipState(s: BrowserStatus, now: number): ChipState {
  const use = s.last_use;
  if (!use || use.family !== s.effective) return 'idle';
  if (use.failed) return 'dropped';
  const at = use.at ? Date.parse(use.at) : NaN;
  return Number.isFinite(at) && now - at < LIVE_MS ? 'live' : 'idle';
}

/** A driver a session of this worker can pick right now. */
export function usable(d: Pick<BrowserDriverInfo, 'state'>): boolean {
  return d.state !== 'unsupported' && d.state !== 'not_installed';
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

type Tone = 'ok' | 'warn' | 'muted';

/** The backend's state word as a menu shows it. The word is decided once, on the backend. */
function StateNote({ state }: { state: BrowserDriverState }) {
  switch (state) {
    case 'running':
      return <Trans>running</Trans>;
    case 'ready':
      return <Trans>ready</Trans>;
    case 'connected':
      return <Trans>connected</Trans>;
    case 'not_connected':
      return <Trans>not connected</Trans>;
    case 'not_installed':
      return <Trans>not installed</Trans>;
    default:
      return <Trans>not for this worker</Trans>;
  }
}

const TONE: Record<BrowserDriverState, Tone> = {
  running: 'ok',
  ready: 'ok',
  connected: 'ok',
  not_connected: 'warn',
  not_installed: 'muted',
  unsupported: 'muted',
};

export const smallBtn = 'rounded px-2 py-0.5 text-[11px] border hover:bg-accent';
const primaryBtn = 'rounded px-2 py-0.5 text-[11px] bg-primary text-primary-foreground';

/** Which profile a driver runs on: Flowpad's own (a managed window), or the one the worker's
 *  extension was found in. */
function useProfileNote(status: BrowserStatus | null) {
  const found = status ? extensionProfile(status) : null;
  return (d: BrowserDriverInfo): React.ReactNode =>
    d.managed ? (
      <Trans>Profile: {d.config.profile || 'default'}</Trans>
    ) : found ? (
      <Trans>Profile: {found}</Trans>
    ) : (
      <Trans>Profile not found</Trans>
    );
}

/** What a kind's row says beside its name: how it is driven, and when its profile was last used
 *  and created. */
function KindNote({ kind }: { kind: BrowserKindInfo }) {
  const used = formatDay(kind.last_used);
  const created = formatDay(kind.created);
  return (
    <span className="flex gap-1.5">
      <span>
        {kind.browser} · {kind.driving}
      </span>
      {used && (
        <span data-testid={`browser-row-${kind.kind}-used`}>
          <Trans>used {used}</Trans>
        </span>
      )}
      {created && (
        <span data-testid={`browser-row-${kind.kind}-created`}>
          <Trans>created {created}</Trans>
        </span>
      )}
    </span>
  );
}

/** Add browser: every browser this Flowpad ships, what it needs for this session's worker, and
 *  "Use it". Nothing here knows a browser by name: each one describes itself. */
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
  const profileNote = useProfileNote(status);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[420px] p-4" data-testid="add-browser-dialog">
        <DialogTitle className="text-sm">
          <Trans>Add browser</Trans>
        </DialogTitle>
        {status.drivers.map((d) => {
          const Glyph = lucideByName(d.icon);
          return (
            <div key={d.name} className="mt-2 rounded-md border px-2.5 py-2 text-xs" data-testid={`add-browser-${d.name}`} data-state={d.state}>
              <div className="flex items-center gap-2">
                <Glyph className="h-3.5 w-3.5" />
                <span className="font-semibold">{d.title}</span>
                <span
                  className={cn(
                    'text-[11px]',
                    TONE[d.state] === 'ok' && 'text-green-600 dark:text-green-400',
                    TONE[d.state] === 'warn' && 'text-amber-600 dark:text-amber-400',
                    TONE[d.state] === 'muted' && 'text-muted-foreground',
                  )}
                >
                  · <StateNote state={d.state} />
                </span>
                <span className="ms-auto text-[11px] text-muted-foreground">{usable(d) && profileNote(d)}</span>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">{d.description}</div>
              {d.setup && <div className="mt-1 text-[11px]">{d.setup}</div>}
              {d.probe === 'extension' &&
                (status.extension.profiles ?? []).map((p) => (
                  <div key={`${p.browser}/${p.name}`} className="flex items-center gap-2 pt-1" data-testid="add-browser-profile">
                    <ProfileLabel profile={p} />
                    <span className={cn('ms-auto text-[11px]', p.installed ? 'text-green-500' : 'text-muted-foreground')}>
                      {p.installed ? <Trans>extension ✓</Trans> : <Trans>no extension</Trans>}
                    </span>
                  </div>
                ))}
              <div className="mt-2 flex justify-end gap-1.5">
                {d.install_url && d.state === 'not_installed' && (
                  <a className={smallBtn} href={d.install_url} target="_blank" rel="noreferrer">
                    <Trans>Install</Trans>
                  </a>
                )}
                <button type="button" className={smallBtn} onClick={() => void onRefresh()}>
                  <Trans>Check again</Trans>
                </button>
                <button
                  type="button"
                  className={primaryBtn}
                  disabled={!usable(d) || d.name === status.effective}
                  onClick={() => {
                    onUse(d.name);
                    onOpenChange(false);
                  }}
                  data-testid={`add-browser-use-${d.name}`}
                >
                  <Trans>Use it</Trans>
                </button>
              </div>
            </div>
          );
        })}
      </DialogContent>
    </Dialog>
  );
}

/** Footer chip: the browser this session (or, outside a session, a new session of the project)
 *  uses, whether it is available, why it is that one, and a picker. Picking is the person's own
 *  choice for this project on this computer; a session picks it up at its next launch. */
export function BrowserChip() {
  const { t } = useLingui();
  const { project, status, refresh } = useBrowserStatus();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  if (!project || !status) return null;

  const state = chipState(status, Date.now());
  const inUse = effectiveDriver(status);
  const choose = async (browser: SessionBrowser) => {
    await project.setBrowser(browser);
    await refresh();
  };
  const label = inUse?.title ?? status.effective;
  const Icon = lucideByName(inUse?.icon);
  const asked = status.drivers.find((d) => d.name === status.requested);
  const why = asked
    ? t`${asked.title} is not for this worker`
    : status.source === 'pick'
      ? t`Your pick on this computer`
      : status.source === 'session'
        ? t`Set for this session`
        : status.source === 'project'
          ? t`Recommended by this project`
          : t`Default`;
  // One row per browser kind: a driver's window, or one of the machine's browser profiles.
  const row = (k: BrowserKindInfo) => {
    const Glyph = lucideByName(k.icon);
    const pickable = usable(k);
    return (
      <Row
        key={k.kind}
        testId={`browser-row-${k.kind}`}
        icon={<Glyph className="h-3.5 w-3.5" />}
        name={k.name}
        note={<StateNote state={k.state} />}
        tone={TONE[k.state]}
        profile={<KindNote kind={k} />}
        selected={pickable && k.driver === status.effective}
        disabled={!pickable}
        onSelect={() => void choose(k.driver)}
        action={
          k.state === 'not_installed' && k.install_url ? (
            <a className={smallBtn} href={k.install_url} target="_blank" rel="noreferrer">
              <Trans>Install</Trans>
            </a>
          ) : k.state === 'not_connected' ? (
            <button type="button" className={primaryBtn} onClick={() => void refresh()}>
              <Trans>Reconnect</Trans>
            </button>
          ) : null
        }
      />
    );
  };
  // Where a dropped browser can fall back to: the first other one this worker can use.
  const fallback = status.drivers.find((d) => d.name !== status.effective && usable(d));

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
        <PopoverContent align="end" className="w-[34rem] max-w-[95vw] p-0" data-testid="browser-picker">
          <div className="flex items-baseline justify-between gap-2 px-3 py-2 text-xs">
            <span className="font-semibold">
              <Trans>Browser</Trans>
            </span>
            <span className="text-[11px] text-muted-foreground" data-testid="browser-source" data-source={status.source}>
              {why}
            </span>
          </div>
          {(status.kinds ?? []).map(row)}
          {state === 'dropped' && fallback && (
            <div className="flex gap-1.5 border-t px-3 py-1.5" data-testid="browser-dropped">
              <button type="button" className={smallBtn} onClick={() => void choose(fallback.name)}>
                <Trans>Use {fallback.title}</Trans>
              </button>
            </div>
          )}
          {status.pick && (
            <button
              type="button"
              data-testid="browser-unpick"
              onClick={() => void choose('')}
              className="flex w-full border-t px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
            >
              <Trans>Use the project's choice</Trans>
            </button>
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

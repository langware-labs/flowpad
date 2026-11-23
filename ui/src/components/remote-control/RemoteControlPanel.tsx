import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Cast, ExternalLink, Fingerprint, KeyRound } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  decodeAssertion,
  formatAccessKeyCode,
  remoteControlService,
  type MachineAccessKey,
  type RemoteControlStatus,
  type RemoteControlUnavailableReason,
} from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { SEGMENTED_ACTIVE, SEGMENTED_GROUP, SEGMENTED_IDLE } from '@src/components/ui/segmented';
import { Switch } from '@src/components/ui/switch';
import { useClock } from '@src/hooks/useActivity';
import { errorDetail } from '@src/lib/error-message';
import { openExternal } from '@src/lib/open-external';
import { cn } from '@src/lib/utils';

const ROW_BUTTON = 'h-7 shrink-0 px-2.5 text-xs';

/**
 * This machine's remote-control status: ONE copy for everything that shows it — the top bar and its panel
 * (`useRemoteControl`) and the Machines page (`useRemoteControlStatus`). Held only while something reads it.
 */
const statusListeners = new Set<() => void>();
let sharedStatus: RemoteControlStatus | null = null;
// Only the call started last may write the status: a slow earlier read must not undo a later one.
let latestCall = 0;

function subscribeToStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
    if (statusListeners.size > 0) return;
    // Nobody reads it any more: the next reader starts from nothing, and a call still out writes nothing.
    sharedStatus = null;
    latestCall += 1;
  };
}

const getStatus = (): RemoteControlStatus | null => sharedStatus;

function publishStatus(next: RemoteControlStatus | null): void {
  sharedStatus = next;
  for (const listener of statusListeners) listener();
}

/** This machine's remote-control status as last read by anyone on the page; null until first read. */
export function useRemoteControlStatus(): RemoteControlStatus | null {
  return useSyncExternalStore(subscribeToStatus, getStatus, getStatus);
}

/** Read the machine's own state (no hub call) into the shared status. A failed read keeps what is held. */
export async function readRemoteControlStatus(): Promise<void> {
  const mine = ++latestCall;
  try {
    const next = await remoteControlService.status();
    if (mine === latestCall) publishStatus(next);
  } catch (error) {
    console.error('[RemoteControlPanel] status read failed', error);
  }
}

/** A key may still be on its way from the hub: one was asked for, or none is accepted yet. */
function awaitsKey(status: RemoteControlStatus): boolean {
  return status.available && (!!status.request || !status.keys.some((key) => key.state === 'accepted'));
}

/** Remote control of this machine, as the panel and the menu row read and change it. */
export interface RemoteControl {
  /** Null until first read. */
  status: RemoteControlStatus | null;
  failed: boolean;
  /** What the machine answered when it refused the fingerprint (its own words), until the next act. */
  refusal: string | null;
  /** A key was accepted with Allow in this session — not through this machine's own request. */
  allowedByHand: boolean;
  busy: boolean;
  /** The machine's own state, no hub call. */
  reload: () => Promise<void>;
  /** The panel opened: the machine's own state, and the hub's keys only while one may still be on its way. */
  opened: () => Promise<void>;
  addKey: () => Promise<void>;
  allow: (credentialId: string) => Promise<void>;
  /** Ask for `hours` of remote control: opens the hub page that asks for the fingerprint. Nothing is on yet. */
  turnOn: (hours: number) => Promise<void>;
  /** Give the machine the signed answer the hub page handed back (still encoded, as the address carries it). */
  confirm: (encodedAssertion: string) => Promise<void>;
  /** Lock now: off at once. */
  lock: () => Promise<void>;
}

/**
 * The state behind the Remote control panel. Reads nothing by itself: the owner says when
 * (`reload` for the menu row, `opened` when the panel opens) — except at the end of an open
 * window, when it reads once so the bar stops saying "on" the moment the machine turned itself off.
 *
 * A key is added, and a turn-on confirmed, on the hub page in the browser: `addKey` / `turnOn` ask
 * the machine for the address and open it. While an add request is open the keys are read again
 * each time the person comes back to the window.
 */
export function useRemoteControl(): RemoteControl {
  const status = useRemoteControlStatus();
  const [failed, setFailed] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [allowedByHand, setAllowedByHand] = useState(false);
  const [inFlight, setInFlight] = useState(0);

  // One call to the machine: counted while it is out, and said when it failed (`onRefused` says it instead).
  // `onDone` gets the answer of the call started last only.
  const run = useCallback(
    async <T,>(call: () => Promise<T>, onDone?: (result: T) => void, onRefused?: (error: unknown) => void) => {
      const mine = ++latestCall;
      setInFlight((n) => n + 1);
      try {
        const result = await call();
        if (mine === latestCall) {
          onDone?.(result);
          setFailed(false);
        }
      } catch (error) {
        console.error('[RemoteControlPanel] call failed', error);
        if (onRefused) onRefused(error);
        else if (mine === latestCall) setFailed(true);
      } finally {
        setInFlight((n) => n - 1);
      }
    },
    [],
  );

  const reload = useCallback(() => run(() => remoteControlService.status(), publishStatus), [run]);
  // The account's keys read from the hub first; the machine's own state when it cannot be reached.
  const refresh = useCallback(
    () => run(() => remoteControlService.refresh().catch(() => remoteControlService.status()), publishStatus),
    [run],
  );
  const opened = useCallback(
    () =>
      run(async () => {
        const own = await remoteControlService.status();
        return awaitsKey(own) ? remoteControlService.refresh().catch(() => own) : own;
      }, publishStatus),
    [run],
  );
  const allow = useCallback(
    (id: string) => {
      setRefusal(null);
      setAllowedByHand(true);
      return run(() => remoteControlService.allow(id), publishStatus);
    },
    [run],
  );
  const lock = useCallback(() => {
    setRefusal(null);
    return run(() => remoteControlService.lock(), publishStatus);
  }, [run]);
  const confirm = useCallback(
    (encodedAssertion: string) => {
      setRefusal(null);
      return run(
        async () => remoteControlService.confirm(decodeAssertion(encodedAssertion)),
        publishStatus,
        // An answer the machine refused (or text that is no answer at all) is said in its own words.
        (error) => {
          const message = errorDetail(error);
          if (message) setRefusal(message);
          else setFailed(true);
        },
      );
    },
    [run],
  );

  // The two acts that continue in the browser: the machine names the page, nothing is on or accepted here yet.
  const addKey = useCallback(() => {
    setRefusal(null);
    return run(
      async () => {
        const request = await remoteControlService.request();
        openExternal(request.url);
        return request;
      },
      (request) =>
        publishStatus(
          sharedStatus && { ...sharedStatus, request: { id: request.request_id, expires_at: request.expires_at } },
        ),
    );
  }, [run]);

  const turnOn = useCallback(
    (hours: number) => {
      setRefusal(null);
      return run(async () => openExternal((await remoteControlService.turnOn(hours)).url));
    },
    [run],
  );

  // While a request is open the key is being added in the browser: read again when the person returns.
  const requestOpen = !!status?.request;
  useEffect(() => {
    if (!requestOpen) return;
    let last = 0;
    const refreshIfActive = () => {
      if (document.visibilityState !== 'visible') return;
      // `focus` and `visibilitychange` both land on a return; one read is enough.
      const now = Date.now();
      if (now - last < 100) return;
      last = now;
      void refresh();
    };
    document.addEventListener('visibilitychange', refreshIfActive);
    window.addEventListener('focus', refreshIfActive);
    return () => {
      document.removeEventListener('visibilitychange', refreshIfActive);
      window.removeEventListener('focus', refreshIfActive);
    };
  }, [requestOpen, refresh]);

  // The window closes by itself at its deadline: read once then, so the bar and the panel follow.
  const openUntil = status?.on ? status.open_until : null;
  useEffect(() => {
    if (!openUntil) return;
    // A second past the deadline: a read that lands a moment early would still answer "on", and nothing reads again.
    const id = window.setTimeout(() => void reload(), Math.max(0, Date.parse(openUntil) - Date.now()) + 1000);
    return () => window.clearTimeout(id);
  }, [openUntil, reload]);

  return {
    status,
    failed,
    refusal,
    allowedByHand,
    busy: inFlight > 0,
    reload,
    opened,
    addKey,
    allow,
    turnOn,
    confirm,
    lock,
  };
}

/**
 * Whole minutes from `now` until `until`, never below zero. Rounded up for a deadline someone must beat (a
 * pending key), down for a window that is running out ("59 min left" a second after an hour was opened) — but
 * never 0 while any time is left.
 */
function minutesLeft(until: string, now: number, round: 'up' | 'down'): number {
  const ms = Date.parse(until) - now;
  if (!(ms > 0)) return 0;
  return round === 'up' ? Math.ceil(ms / 60_000) : Math.max(1, Math.floor(ms / 60_000));
}

/** The minutes until `until`, on the app's one ticking clock — which this keeps running only while time is left. */
function useMinutesLeft(until: string, round: 'up' | 'down' = 'up'): number {
  const running = Date.parse(until) > Date.now();
  const now = useClock(running);
  // Past the deadline the clock is no longer followed, and its last value may be older than the deadline.
  return running ? minutesLeft(until, now, round) : 0;
}

/** "7 min left", counting down — its own component so the panel does not re-render with the clock. */
function MinutesLeft({ expiresAt, onExpired }: { expiresAt: string; onExpired: () => void }) {
  const { t } = useLingui();
  const minutes = useMinutesLeft(expiresAt);
  useEffect(() => {
    if (minutes === 0) onExpired();
    // Once, when the count reaches zero — not on every new `onExpired` identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minutes]);
  return <span data-testid="remote-control-key-expiry">{t`${minutes} min left`}</span>;
}

/**
 * How long remote control stays on: "59 min left", or "2 h 5 min left" above an hour. Ticks by
 * itself, so neither the panel nor the bar re-renders with the clock.
 */
export function RemoteControlTimeLeft({ until }: { until: string }) {
  const { t } = useLingui();
  const minutes = useMinutesLeft(until, 'down');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return (
    <span className="tabular-nums" data-testid="remote-control-time-left">
      {minutes >= 60 ? t`${hours} h ${rest} min left` : t`${minutes} min left`}
    </span>
  );
}

/** One key: icon, its label, then "accepted · code …" or "new · code … · N min left" with Allow. */
function KeyRow({
  accessKey,
  busy,
  onAllow,
  onExpired,
}: {
  accessKey: MachineAccessKey;
  busy: boolean;
  onAllow: () => void;
  onExpired: () => void;
}) {
  const { t } = useLingui();
  const pending = accessKey.state === 'pending';
  const code = formatAccessKeyCode(accessKey.code);
  return (
    <li
      className="flex items-center gap-2 px-1 py-1"
      data-testid="remote-control-key-row"
      data-state={accessKey.state}
      data-credential-id={accessKey.credential_id}
    >
      <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
        <span className="min-w-0 truncate font-medium text-foreground">{accessKey.label}</span>
        <span className="text-muted-foreground">
          {pending ? t`new · code ${code}` : t`accepted · code ${code}`}
          {pending && accessKey.expires_at && (
            <>
              {' · '}
              <MinutesLeft expiresAt={accessKey.expires_at} onExpired={onExpired} />
            </>
          )}
        </span>
      </span>
      {pending && (
        <Button size="sm" className={ROW_BUTTON} onClick={onAllow} disabled={busy} data-testid="remote-control-allow">
          <Trans>Allow</Trans>
        </Button>
      )}
    </li>
  );
}

/**
 * Remote control of THIS machine, as the panel that drops from the top bar's menu: whether it is
 * on and until when, and the access keys the machine accepted. Content only — `TopBarMoreMenu`
 * owns the popover and the state (`useRemoteControl`), so its menu row can say "on" / "off" from
 * the same read.
 *
 * Turning on IS the fingerprint step: Turn on (and the switch, when off) asks the machine for the
 * chosen hours and opens the hub page that runs the passkey prompt; the answer comes back through
 * the address the page hands the app (`TopBarMoreMenu`). It then stays on until its deadline or
 * Lock now (the switch, when on). There is no "on" without a fingerprint, and no key is removed
 * here — that is the hub page's Remove.
 */
export function RemoteControlPanel({ control, className }: { control: RemoteControl; className?: string }) {
  const { t } = useLingui();
  const { currentUser } = useAuth();
  const { status, failed, refusal, busy, opened, reload } = control;
  // The window length the person picked; until they pick, the first one the machine offers.
  const [hours, setHours] = useState<number | null>(null);

  useEffect(() => {
    void opened();
  }, [opened]);

  const title = (
    <>
      <Cast className="h-3 w-3 shrink-0 text-foreground" aria-hidden />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
        <Trans>Remote control</Trans>
      </span>
    </>
  );

  if (!status || !status.available) {
    const unavailable: Record<RemoteControlUnavailableReason, string> = {
      signed_out: t`Sign in to Flowpad to use remote control.`,
      private: t`Remote control is not available in private mode.`,
      identity: t`Remote control is not available on a machine signed in as an agent.`,
    };
    const state = !status ? (failed ? 'error' : 'loading') : 'unavailable';
    return (
      <section className={cn('space-y-2', className)} data-testid="remote-control-section" data-state={state}>
        <div className="flex items-center gap-1.5">{title}</div>
        <p className="text-muted-foreground" data-testid="remote-control-unavailable">
          {!status
            ? failed
              ? t`Could not read remote control on this machine.`
              : t`Loading…`
            : ((status.reason && unavailable[status.reason]) ?? unavailable.signed_out)}
        </p>
      </section>
    );
  }

  const accepted = status.keys.filter((key) => key.state === 'accepted');
  const hasKey = accepted.length > 0;
  const requestOpen = !!status.request;
  const state = status.on ? 'on' : hasKey ? 'off' : status.keys.length ? 'pending' : 'no-key';
  const hoursOptions = status.hours_options;
  const chosenHours = hours !== null && hoursOptions.includes(hours) ? hours : hoursOptions[0];
  const lastHours = status.hours;
  // Never turned on yet, and the key did not need Allow: it came back from this machine's own request.
  const fresh = hasKey && !status.last_off && lastHours === null && !control.allowedByHand;

  // What the panel says under its header while off; nothing while on (the open row says it).
  const hint = status.on ? null : !hasKey ? (
    <Trans>Add an access key to turn this on.</Trans>
  ) : status.last_off === 'expired' && lastHours !== null ? (
    lastHours === 1 ? (
      <Trans>Off. It turned itself off after 1 hour. Turning it on needs your fingerprint again.</Trans>
    ) : (
      <Trans>Off. It turned itself off after {lastHours} hours. Turning it on needs your fingerprint again.</Trans>
    )
  ) : status.last_off ? (
    <Trans>Off. Turning it on needs your fingerprint again.</Trans>
  ) : fresh ? (
    <Trans>Your new key was added from this machine, so it is accepted here.</Trans>
  ) : null;

  return (
    <section className={cn('space-y-2', className)} data-testid="remote-control-section" data-state={state}>
      <div className="flex items-center gap-1.5">
        {title}
        <span className="text-[11px] text-muted-foreground" data-testid="remote-control-state">
          {status.on ? t`on` : t`off`}
        </span>
        <Switch
          id="remote-control-switch"
          className="ms-auto"
          checked={status.on}
          disabled={busy || (!hasKey && !status.on)}
          // Off → the same as Turn on, for the chosen hours; on → Lock now.
          onCheckedChange={(on) => void (on === true ? control.turnOn(chosenHours) : control.lock())}
          aria-label={t`Remote control`}
          data-testid="remote-control-switch"
        />
      </div>
      {hint && (
        <p className="text-muted-foreground" data-testid="remote-control-hint">
          {hint}
        </p>
      )}
      {status.on && (
        <div
          className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 py-1 pe-1 ps-2"
          data-testid="remote-control-open-row"
        >
          <span className="min-w-0 truncate font-medium text-amber-600 dark:text-amber-400">
            {currentUser?.email ?? ''}
          </span>
          <span className="min-w-0 flex-1 text-muted-foreground">
            {status.open_until && <RemoteControlTimeLeft until={status.open_until} />}
          </span>
          <Button
            size="sm"
            variant="outline"
            className={ROW_BUTTON}
            onClick={() => void control.lock()}
            disabled={busy}
            data-testid="remote-control-lock"
          >
            <Trans>Lock now</Trans>
          </Button>
        </div>
      )}

      <div className="space-y-1 border-t border-border pt-2">
        <div className="flex items-center gap-1.5">
          <KeyRound className="h-3 w-3 shrink-0 text-foreground" aria-hidden />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
            <Trans>Access keys</Trans>
          </span>
          <span className="text-[11px] text-muted-foreground" data-testid="remote-control-key-count">
            {status.keys.length}
          </span>
        </div>
        {status.keys.length > 0 ? (
          <ul>
            {status.keys.map((key) => (
              <KeyRow
                key={key.credential_id}
                accessKey={key}
                busy={busy}
                onAllow={() => void control.allow(key.credential_id)}
                onExpired={() => void reload()}
              />
            ))}
          </ul>
        ) : (
          <div className="flex items-center gap-2 px-1 py-1">
            <span className="min-w-0 flex-1 text-muted-foreground" data-testid="remote-control-no-keys">
              <Trans>No access keys</Trans>
            </span>
            <Button
              size="sm"
              className="shrink-0"
              onClick={() => void control.addKey()}
              disabled={busy}
              data-testid="remote-control-add-key"
            >
              <Trans>Add access key</Trans>
              <ExternalLink className="!size-3" aria-hidden />
            </Button>
          </div>
        )}
        {/* Only while the key has not come back: an older request still open says nothing once one is accepted. */}
        {requestOpen && !hasKey && (
          <p className="px-1 text-muted-foreground" data-testid="remote-control-request-open">
            <Trans>Finish adding the key in your browser, then come back here.</Trans>
          </p>
        )}
        {(refusal || failed) && (
          <p className="px-1 text-destructive" role="alert" data-testid="remote-control-error">
            {refusal ?? <Trans>That did not work. Try again.</Trans>}
          </p>
        )}
      </div>

      {hasKey && !status.on && (
        <div className="flex items-center gap-2 border-t border-border pt-2">
          <span className="shrink-0 text-muted-foreground" id="remote-control-window-label">
            <Trans>Stay on for</Trans>
          </span>
          <div
            role="radiogroup"
            aria-labelledby="remote-control-window-label"
            className={cn(SEGMENTED_GROUP, 'rounded-full')}
            data-testid="remote-control-window"
          >
            {hoursOptions.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={option === chosenHours}
                disabled={busy}
                onClick={() => setHours(option)}
                className={cn(
                  'flex h-5 items-center justify-center rounded-full px-2 text-[11px] tabular-nums transition-colors',
                  option === chosenHours ? SEGMENTED_ACTIVE : SEGMENTED_IDLE,
                )}
                data-testid={`remote-control-window-${option}`}
              >
                {t`${option} h`}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            className="ms-auto shrink-0"
            onClick={() => void control.turnOn(chosenHours)}
            disabled={busy}
            data-testid="remote-control-turn-on"
          >
            <Fingerprint className="!size-3.5" aria-hidden />
            <Trans>Turn on</Trans>
          </Button>
        </div>
      )}
    </section>
  );
}

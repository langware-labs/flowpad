import { t } from '@lingui/core/macro';
import { AgenticProcess, connectionManager, dataContext, Shell, tabManager, Tab, toplog, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { Button } from '@src/components/ui/button';
import { sinceTabSwitch } from '@src/navigation/tab-switch-state';
import { notify } from '@src/notifications';
import { AlertTriangle, LoaderCircle, PlayCircle, RefreshCw } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import InteractiveTerminal from './interactive-terminal';
import { useProcessSurface } from './interactive-terminal/use-process-surface';
import { retryFailedStart, TerminalRuntimeErrorBanner } from './interactive-terminal/TerminalRuntimeErrorBanner';
import { estimateCols, estimateRows } from './interactive-terminal/terminalConfig';
import { allowRename, cleanTitle, isProgramIdentityTitle } from './rename-rules';
import {
  classifyRuntimeFailure,
  describeProcessStartError,
  type ProcessLoadErrorKind,
} from '@src/routes/loaders/load-process';

/**
 * Always-VISIBLE dead-end state for a panel that has nothing to render: the
 * process entity loaded but carries no shell and isn't headless. The specific
 * loader-recorded failure (if any) shows via `TerminalRuntimeErrorBanner` on
 * top; the centered body below is unconditional, so this branch can never
 * collapse to a silent blank pane again (the pty_mode=false regression).
 */
export const TerminalPanelErrorState: React.FC<{
  processId?: string;
  /** Pass the parent's already-subscribed entity (TerminalPanel) to avoid a
   *  duplicate subscription; omitted → the overlay path resolves its own. */
  process?: AgenticProcess | null;
}> = ({ processId, process }) => {
  const [busy, setBusy] = useState(false);
  const { data: fetched } = useEntity<AgenticProcess>(
    !process && processId ? new TypeId(AgenticProcess.type, processId) : null,
  );
  const liveProcess = process ?? fetched;

  // retryFailedStart (shared with the banner) resolves the process, calls
  // start({visible:true, retry:true}) — clearing any server-side
  // `start_failure` latch — and owns the success/error toasts. On success the
  // entity broadcast delivers the new shell_id and the panel re-renders into
  // InteractiveTerminal.
  const handleRestart = async (): Promise<void> => {
    if (!processId) return;
    setBusy(true);
    try {
      await retryFailedStart(processId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col" data-testid="terminal-panel-error">
      <TerminalRuntimeErrorBanner processId={processId} />
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <AlertTriangle className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <div className="text-sm font-medium">This session has nothing to display</div>
        <div className="max-w-md text-xs text-muted-foreground">
          {/* Prefer the server-recorded launch failure (`start_failure` latch)
              over the generic copy when the entity carries one. */}
          {liveProcess?.start_failure ??
            'No terminal or chat is attached to this process. Restart it to spawn a fresh session, or reload if this looks like a stale page.'}
        </div>
        <div className="mt-2 flex gap-2">
          {processId && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void handleRestart()}
              data-testid="terminal-panel-error-restart"
            >
              <PlayCircle className="h-3.5 w-3.5" />
              {busy ? 'Working…' : 'Restart session'}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => window.location.reload()}
            data-testid="terminal-panel-error-reload"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
};

const TerminalPanelStartingState: React.FC = () => (
  <div
    className="flex h-full w-full items-center justify-center gap-2 text-sm text-muted-foreground"
    data-testid="terminal-panel-starting"
  >
    <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
    Starting session…
  </div>
);

type ProcessRuntimeStatus = 'idle' | 'starting' | 'ready' | 'failed';

// React StrictMode remounts effects, and the same entity can be projected in
// more than one terminal surface. Backend `open` is a mutation, so share one
// in-flight start per entity instead of launching concurrent workers/attaches.
const runtimeStarts = new Map<string, Promise<void>>();

/**
 * Start a terminal's runtime from its mounted panel — never from a route loader
 * (docs/navigation/dock-loading.md, I3), so a slow `open` cannot hold the URL.
 * initSdk connects FlowSync asynchronously: wait for it here, after the route
 * committed, so a cold socket cannot make the attach race the connection.
 */
function startRuntime(key: string, open: () => Promise<unknown>): Promise<void> {
  const existing = runtimeStarts.get(key);
  if (existing) return existing;

  const pending = (async () => {
    const tConnected = performance.now();
    try {
      await connectionManager.waitForConnected(5000);
      toplog.log(
        'agentic_process.load',
        `startRuntime waitForConnected took ${(performance.now() - tConnected).toFixed(0)}ms key=${key}`,
      );
    } catch {
      toplog.log('agentic_process.load', `startRuntime waitForConnected timed out key=${key}`);
      notify.error({
        title: t`No realtime connection`,
        message: t`Terminal may be unresponsive until the connection recovers.`,
      });
    }
    await open();
  })().finally(() => {
    if (runtimeStarts.get(key) === pending) runtimeStarts.delete(key);
  });
  runtimeStarts.set(key, pending);
  return pending;
}

function startProcessRuntime(process: AgenticProcess, cols: number, rows: number): Promise<void> {
  // A user opening a session IS an explicit retry: mounting this terminal is
  // a deliberate human action, not an automatic loader/watchdog poll. Pass
  // retry:true so a process left in a start_failure latch (e.g. a prior
  // worker instant-exit) relaunches instead of surfacing "use Retry to
  // relaunch" — opening a session should open it. The gate still protects the
  // genuinely-automatic callers, which pass retry=false (the recovery
  // watchdog) or never call start at all (the route loader).
  return startRuntime(process.typeId.toString(), () => process.start({ visible: true, cols, rows, retry: true }));
}

/** A plain shell: `open` (re)creates or re-finds its PTY, then attaches it. */
function startShellRuntime(shell: Shell, cols: number, rows: number): Promise<void> {
  return startRuntime(shell.typeId.toString(), () => shell.ensureStarted({ cols, rows, workdir: shell.workdir ?? undefined }));
}

/** A plain shell whose `open` failed: say so on the panel, with a way to try again. */
const ShellStartFailedState: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div
    className="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center"
    data-testid="terminal-shell-start-failed"
  >
    <AlertTriangle className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
    <div className="text-sm font-medium">{t`This terminal could not be opened`}</div>
    <div className="max-w-md text-xs text-muted-foreground">{message}</div>
    <Button size="sm" className="mt-2" onClick={onRetry} data-testid="terminal-shell-start-retry">
      <RefreshCw className="h-3.5 w-3.5" />
      {t`Try again`}
    </Button>
  </div>
);

/**
 * One warm-mounted terminal panel. Renders from a `Tab` plus its OWN live
 * entity (URL-first corollary: the view hydrates + attaches on mount, not via a
 * list-wide join). A process panel resolves its transport shell from the live
 * `AgenticProcess.shell_id` (so a worker restart reconnects the PTY); a plain
 * shell's transport is its target id. Process OSC titles are observations for
 * the backend naming policy; plain shells retain their terminal auto-title path.
 */
const TerminalPanelBody: React.FC<{
  tab: Tab;
  isActive: boolean;
}> = ({ tab, isActive }) => {
  const isProcess = tab.target_type === AgenticProcess.type;
  const targetId = tab.target_id ?? '';
  const { data: process } = useEntity<AgenticProcess>(
    isProcess && targetId ? new TypeId(AgenticProcess.type, targetId) : null,
  );
  const { data: shell } = useEntity<Shell>(!isProcess && targetId ? new TypeId(Shell.type, targetId) : null);
  const [runtimeStatus, setRuntimeStatus] = useState<ProcessRuntimeStatus>('idle');
  const getSurfaceDims = React.useCallback(
    () => ({ cols: estimateCols(window.innerWidth), rows: estimateRows(window.innerHeight) }),
    [],
  );
  // Transport reconciliation belongs to the always-mounted panel, not the
  // InteractiveTerminal child hidden by the startup gate. This records the
  // opening mode during `/open`, retains any URL mode change made meanwhile,
  // and performs it only after the startup mutation is ready.
  const reconciledProcess = useProcessSurface({
    process: isActive ? process : null,
    getDims: getSurfaceDims,
    canSwitch: runtimeStatus === 'ready',
    subscribeToProcess: false,
  });
  const activeProcess = reconciledProcess ?? process;
  const transportShellId = isProcess ? (activeProcess?.shell_id ?? '') : targetId;
  const processRef = useRef(activeProcess);
  processRef.current = activeProcess;
  const processReady = activeProcess != null;

  // A route loader resolves only URL identity + project context. The mounted,
  // URL-active panel owns the worker/PTY side effect so a slow `open` action
  // cannot hold React Router on the previous URL. The stale guard prevents a
  // completion from a panel the user already left from clearing or replacing
  // the active panel's runtime error.
  //
  // Deliberately do not depend on `process.pty_mode`: an already-mounted
  // headless→PTY transition is owned by useProcessSurface.switchMode(), which
  // starts the PTY itself. Re-entering this activation effect on that update
  // creates a second `/open` and replaces the live surface with the startup
  // spinner mid-switch.
  useEffect(() => {
    const activeProcess = processRef.current;
    // NOT gated on `isActive` (also absent from the deps): an off-screen panel is
    // still running — "not looked at" is a display fact, not a lifecycle one. The
    // pool renders a panel only once it was shown, so this starts it once.
    if (!isProcess || !activeProcess) {
      setRuntimeStatus('idle');
      return;
    }
    if (activeProcess.pty_mode === false) {
      setRuntimeStatus('ready');
      return;
    }

    let stale = false;
    setRuntimeStatus('starting');
    const cols = estimateCols(window.innerWidth);
    const rows = estimateRows(window.innerHeight);
    void startProcessRuntime(activeProcess, cols, rows)
      .then(() => {
        if (stale) return;
        if (toplog.isOn('tab_switch')) {
          toplog.log('tab_switch', `terminal_runtime_ready ${sinceTabSwitch()} proc=${activeProcess.id.slice(0, 8)}`);
        }
        setRuntimeStatus('ready');
        dataContext.setTerminalRuntimeError(null);
      })
      .catch((cause) => {
        if (stale) return;
        const error = classifyRuntimeFailure(activeProcess.id, activeProcess, cause);
        toplog.log(
          'tab_switch',
          `error ${sinceTabSwitch()} sink=terminal_runtime kind=${error.kind} proc=${activeProcess.id.slice(0, 8)} err:`,
          cause,
        );
        setRuntimeStatus('failed');
        dataContext.setTerminalRuntimeError({
          kind: error.kind as Exclude<ProcessLoadErrorKind, 'entity_not_found'>,
          processId: activeProcess.id,
          shellId: error.shellId ?? null,
        });
      });

    return () => {
      stale = true;
    };
  }, [isProcess, processReady, targetId]);

  // A plain shell's runtime, the same way: opened once per panel, by the panel.
  // Its route loader resolves identity only (dock-loading I3). InteractiveTerminal
  // renders at once and replays when the shell reports connected.
  const [shellStartError, setShellStartError] = useState<string | null>(null);
  const [shellStartAttempt, setShellStartAttempt] = useState(0);
  const shellLoaded = shell != null;
  useEffect(() => {
    if (isProcess || !shell) return;
    let stale = false;
    setShellStartError(null);
    void startShellRuntime(shell, estimateCols(window.innerWidth), estimateRows(window.innerHeight)).catch(
      (cause: unknown) => {
        if (stale) return;
        toplog.log(
          'tab_switch',
          `error ${sinceTabSwitch()} sink=shell_runtime shell=${shell.id.slice(0, 8)} err:`,
          cause,
        );
        setShellStartError(describeProcessStartError(cause).description);
      },
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per panel (and per explicit retry), not per shell broadcast
  }, [isProcess, shellLoaded, targetId, shellStartAttempt]);

  // One line each time this panel falls through to "nothing to display": a process
  // that loaded, is past startup, and has neither a shell nor a headless chat.
  const showsNothing =
    isProcess &&
    !!activeProcess &&
    !activeProcess.isHeadless &&
    runtimeStatus !== 'idle' &&
    runtimeStatus !== 'starting' &&
    !transportShellId;
  useEffect(() => {
    if (!showsNothing || !activeProcess) return;
    toplog.log(
      'tab_switch',
      `error ${sinceTabSwitch()} sink=terminal_panel_nothing_to_display proc=${activeProcess.id.slice(0, 8)} ` +
        `runtime=${runtimeStatus} status=${activeProcess.status ?? '-'} pty_mode=${String(activeProcess.pty_mode)}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per appearance
  }, [showsNothing]);

  const handleTitleChange = (title: string): void => {
    if (tab.is_disabled) return;
    // A process tab has no shell: the backend names a process from its
    // transcript, and an OSC frame is never evidence for it.
    if (!shell || !shell.auto_rename) return; // no shell, or user pinned this shell
    // Clean spinner frames / icons / ANSI off the raw OSC title, then gate on
    // real text and dedupe against the CLEANED name — so animation ticks that
    // reduce to the same title never fire a save.
    const clean = cleanTitle(title);
    if (!allowRename(clean) || shell.name === clean) return;
    // A restarting worker re-announces itself (title `claude` / the exe path)
    // before any tag title exists — never let that clobber the stored name.
    if (isProgramIdentityTitle(clean)) return;
    shell.name = clean;
    void shell.save().catch(() => {});
    // Mirror onto the durable Tab label so the chip stays right once inactive —
    // set_name, NOT rename (which would pin auto_rename off).
    void tabManager.setName(tab.id, clean).catch(() => {});
  };

  return (
    <div
      data-testid="terminal-panel"
      data-session-id={tab.dockPointer?.pointer ?? ''}
      data-worker-session-id={isProcess ? (activeProcess?.session_id ?? '') : undefined}
      data-pty-mode={isProcess ? String(activeProcess?.pty_mode ?? '') : undefined}
      data-active={isActive ? 'true' : 'false'}
      className="absolute inset-0 min-h-0 overflow-hidden"
      style={isActive ? { zIndex: 1 } : { visibility: 'hidden', zIndex: 0 }}
    >
      {/* A headless chat legitimately has NO shell (see AgenticProcess.isHeadless)
          — InteractiveTerminal renders SimpleChatPane without an xterm. Mount it
          shell-less. */}
      {isProcess &&
      activeProcess &&
      !activeProcess.isHeadless &&
      (runtimeStatus === 'idle' || runtimeStatus === 'starting') ? (
        <TerminalPanelStartingState />
      ) : !isProcess && shellStartError ? (
        <ShellStartFailedState message={shellStartError} onRetry={() => setShellStartAttempt((n) => n + 1)} />
      ) : transportShellId || (isProcess && activeProcess?.isHeadless) ? (
        <InteractiveTerminal
          sessionId={transportShellId}
          className="h-full"
          active={isActive}
          process={isProcess ? (activeProcess ?? undefined) : undefined}
          onTitleChange={handleTitleChange}
        />
      ) : isProcess && !activeProcess ? null /* process entity still hydrating */ : (
        // Process loaded but has no shell and isn't headless (worker binary
        // missing / start_failure latch / drift): an unconditional visible
        // error + recovery instead of a silent blank panel.
        <TerminalPanelErrorState processId={targetId} process={activeProcess} />
      )}
    </div>
  );
};

/** Memoized: every show/hide republishes the pool, and only the panels whose `isActive` flipped need to render. */
export const TerminalPanel = React.memo(TerminalPanelBody);

import { t } from '@lingui/core/macro';
import { AgenticProcess, connectionManager, dataContext, Shell, tabKey, tabManager, Tab, toplog, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ProjectHome } from '@src/components/project-home/ProjectHome';
import { Button } from '@src/components/ui/button';
import { DockPointer } from '@src/navigation';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useTerminalTabs } from '@src/tabs/use-tab-manager';
import { notify } from '@src/notifications';
import { AlertTriangle, LoaderCircle, PlayCircle, RefreshCw } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import InteractiveTerminal from './interactive-terminal';
import { useProcessSurface } from './interactive-terminal/use-process-surface';
import { retryFailedStart, TerminalRuntimeErrorBanner } from './interactive-terminal/TerminalRuntimeErrorBanner';
import { estimateCols, estimateRows } from './interactive-terminal/terminalConfig';
import { allowRename, cleanTitle, isProgramIdentityTitle, shouldAutoSaveTitleForTarget } from './rename-rules';
import { classifyRuntimeFailure, type ProcessLoadErrorKind } from '@src/routes/loaders/load-process';

interface TabbedTerminalProps {
  className?: string;
  /** Which terminals the body keeps warm-mounted: the active project's exact
   *  scope (`'project'`, default) or every scope (`'all'`, the dev
   *  sessions view). Matches the `scope` passed to the host's `UnifiedTabStrip`. */
  scope?: 'project' | 'all';
  /** Pin spawned shells/processes to this project (CollaborationSpace / dev view);
   *  otherwise the active project. */
  spawnProjectId?: string | null;
}

/**
 * Always-VISIBLE dead-end state for a panel that has nothing to render: the
 * process entity loaded but carries no shell and isn't headless. The specific
 * loader-recorded failure (if any) shows via `TerminalRuntimeErrorBanner` on
 * top; the centered body below is unconditional, so this branch can never
 * collapse to a silent blank pane again (the pty_mode=false regression).
 */
const TerminalPanelErrorState: React.FC<{
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
      <TerminalRuntimeErrorBanner />
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

// React StrictMode remounts effects, and the same process can be projected in
// more than one terminal surface. Backend `open` is a mutation, so share one
// in-flight start per entity instead of launching concurrent workers/attaches.
const processStarts = new Map<string, Promise<void>>();

function startProcessRuntime(process: AgenticProcess, cols: number, rows: number): Promise<void> {
  const existing = processStarts.get(process.id);
  if (existing) return existing;

  const pending = (async () => {
    // initSdk connects FlowSync asynchronously. Preserve the former readiness
    // budget, but wait here after route commit so a cold socket cannot either
    // block the URL or make attach race the connection startup.
    try {
      await connectionManager.waitForConnected(5000);
    } catch {
      notify.error({
        title: t`No realtime connection`,
        message: t`Terminal may be unresponsive until the connection recovers.`,
      });
    }
    await process.start({ visible: true, cols, rows });
  })().finally(() => {
    if (processStarts.get(process.id) === pending) processStarts.delete(process.id);
  });
  processStarts.set(process.id, pending);
  return pending;
}

/**
 * One warm-mounted terminal panel. Renders from a `Tab` plus its OWN live
 * entity (URL-first corollary: the view hydrates + attaches on mount, not via a
 * list-wide join). A process panel resolves its transport shell from the live
 * `AgenticProcess.shell_id` (so a worker restart reconnects the PTY); a plain
 * shell's transport is its target id. The OSC title auto-save saves the live
 * entity and mirrors the label onto the Tab via `set_name` (no `auto_rename` pin).
 */
const TerminalPanel: React.FC<{
  tab: Tab;
  isActive: boolean;
  isMounted: boolean;
  flow: AgenticProcess | null;
}> = ({ tab, isActive, isMounted, flow }) => {
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
  const source = isProcess ? activeProcess : shell;
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
    // NOT gated on `isActive`, which is also deliberately absent from the deps
    // below. An off-screen panel is still RUNNING: "you are not looking at me"
    // is a DISPLAY fact, not a lifecycle one. Conflating the two reset an
    // already-ready panel to 'idle' on every tab switch, and the render gate
    // below turns 'idle' into the startup spinner *instead of*
    // InteractiveTerminal — so React unmounted a live xterm, and the return trip
    // paid a fresh attach plus a full `replayPtyStream` + `term.reset()`. That
    // is the whole "every tab I jump to redraws" report (FLOWPAD-2054); it
    // arrived in 2435a1f71 / v0.2.114 when this side effect moved out of the
    // route loader, where it had run once per LOAD rather than per activation.
    // `isMounted` is the gate that was actually wanted — it flips true on first
    // activation and never goes back, so the runtime starts once per panel.
    // The headless->PTY refresh is unaffected: it is owned by
    // useProcessSurface.switchMode() and reaches the terminal through a new
    // `shell_id` -> `transportShellId` -> `sessionId`, never through this effect
    // (see the `pty_mode` note above).
    if (!isProcess || !isMounted || !activeProcess) {
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
        setRuntimeStatus('ready');
        dataContext.setTerminalRuntimeError(null);
      })
      .catch((cause) => {
        if (stale) return;
        const error = classifyRuntimeFailure(activeProcess.id, activeProcess, cause);
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
  }, [isMounted, isProcess, processReady, targetId]);

  const handleTitleChange = (title: string): void => {
    if (tab.is_disabled) return;
    if (!shouldAutoSaveTitleForTarget(tab.target_type, isProcess ? activeProcess : null)) return;
    if (!source || !source.auto_rename) return; // user pinned this tab
    // Clean spinner frames / icons / ANSI off the raw OSC title, then gate on
    // real text and dedupe against the CLEANED name — so animation ticks that
    // reduce to the same title never fire a save.
    const clean = cleanTitle(title);
    if (!allowRename(clean) || source.name === clean) return;
    // A restarting worker re-announces itself (title `claude` / the exe path)
    // before any tag title exists — never let that clobber the stored name.
    if (isProgramIdentityTitle(clean, isProcess ? activeProcess : null)) return;
    source.name = clean;
    void source.save().catch(() => {});
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
      {isMounted &&
        // A headless chat legitimately has NO shell (see AgenticProcess.isHeadless)
        // — InteractiveTerminal renders SimpleChatPane without an xterm. Mount it
        // shell-less.
        (isProcess &&
        activeProcess &&
        !activeProcess.isHeadless &&
        (runtimeStatus === 'idle' || runtimeStatus === 'starting') ? (
          <TerminalPanelStartingState />
        ) : transportShellId || (isProcess && activeProcess?.isHeadless) ? (
          <InteractiveTerminal
            sessionId={transportShellId}
            flow={flow}
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
        ))}
    </div>
  );
};

/**
 * TabbedTerminal — the terminal BODY (docs/tab-management.md). It renders only the
 * warm-mounted terminal panels; the chip strip is the shared `UnifiedTabStrip` the
 * host renders above it. Tabs come from the one backend-authoritative source
 * (`useTerminalTabs` → `tab` action), the active panel is URL-derived, and each
 * panel hydrates its own entity on mount. With no tabs it renders `ProjectHome`
 * (the shared project landing, which owns the spawn openers + their modals).
 */
const TabbedTerminal: React.FC<TabbedTerminalProps> = ({ className = '', scope = 'project', spawnProjectId }) => {
  const { flow } = useAgentContext();
  const { currentDock } = useDockNavigation();
  const tabs = useTerminalTabs(scope, spawnProjectId);

  // Active panel = the URL (every tab is keyed by its dockPointer.tabHash).
  // A non-terminal dock's tabHash never matches a terminal tab, so no special-case.
  const activeKey = currentDock?.tabHash ?? '';

  // The URL names a session but NO tab in this scope backs it (scope filtering,
  // backend refusal, cross-project drift): without this arm every panel stays
  // hidden and the pane is silently blank — the recorded load error (if any)
  // has no mounted reader. Rendered as an overlay so warm-mounted sibling
  // panels survive. Loader-materialized tabs land in the store before first
  // render (setupTab is awaited in the route loader), so this is not a
  // hydration flash.
  const activePointer = currentDock?.pointer ?? '';
  const activeProcessId =
    activePointer && DockPointer.isAgenticProcessPointer(activePointer)
      ? DockPointer.extractAgenticProcessId(activePointer)
      : undefined;
  const activeTabMissing = !!activeKey && tabs.length > 0 && !tabs.some((t) => tabKey(t) === activeKey);

  // Lazy-mount: mount the active panel on first visit; keep mounted ones warm
  // (the Set never shrinks) so re-activation is instant.
  const [mounted, setMounted] = useState<Set<string>>(() => new Set(activeKey ? [activeKey] : []));
  useEffect(() => {
    if (!activeKey) return;
    setMounted((prev) => {
      // Warm switch = the panel is already in the Set (visibility flip only);
      // cold = first visit mounts InteractiveTerminal (attach + replay).
      toplog.log(
        'process_load',
        `TabbedTerminal active flip → ${activeKey} (${prev.has(activeKey) ? 'warm' : 'cold mount'})`,
      );
      if (prev.has(activeKey)) return prev;
      const next = new Set(prev);
      next.add(activeKey);
      return next;
    });
  }, [activeKey]);

  return (
    <div className={`flex h-full ${className}`}>
      <div className="flex h-full w-full flex-col">
        <div className="relative flex-1 overflow-hidden" data-testid="terminal-panels">
          {tabs.length === 0 ? (
            <ProjectHome spawnProjectId={spawnProjectId} createOnly />
          ) : (
            tabs.map((tab) => {
              const tabHash = tabKey(tab);
              return (
                <TerminalPanel
                  key={tabHash}
                  tab={tab}
                  isActive={tabHash === activeKey}
                  isMounted={mounted.has(tabHash)}
                  flow={flow ?? null}
                />
              );
            })
          )}
          {activeTabMissing && (
            <div className="absolute inset-0 z-10 bg-background" data-testid="terminal-active-tab-missing">
              <TerminalPanelErrorState processId={activeProcessId} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default TabbedTerminal;

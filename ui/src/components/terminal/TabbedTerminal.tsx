import { AgenticProcess, tabInProject, tabKey, toplog, TypeId } from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { useEntity } from '@src/hooks/entity-hooks';
import { ProjectHome } from '@src/components/project-home/ProjectHome';
import { DockPointer } from '@src/navigation';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useTerminalTabs } from '@src/tabs/use-tab-manager';
import { sinceTabSwitch } from '@src/navigation/tab-switch-state';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { terminalPool } from './terminal-pool';
import { TerminalPanelErrorState } from './TerminalPanel';

interface TabbedTerminalProps {
  className?: string;
  /** Which terminal tabs this body answers for: the active project's exact
   *  scope (`'project'`, default) or every scope (`'all'`, the dev
   *  sessions view). Matches the `scope` passed to the host's `UnifiedTabStrip`. */
  scope?: 'project' | 'all';
  /** Pin spawned shells/processes to this project (CollaborationSpace / dev view);
   *  otherwise the active project. */
  spawnProjectId?: string | null;
  /**
   * Process this pane is mounted for — a bare id or a full
   * `agentic_process-<id>` pointer. When given and that process carries no
   * shell, the pane renders "Disconnected" instead of the terminal body.
   * Omitted by the plain /dock/shell host, which is not process-scoped.
   */
  processId?: string;
}

/**
 * TabbedTerminal — the terminal BODY (docs/tab-management.md), and a SLOT of the
 * terminal pool (docs/navigation/dock-loading.md, I6). It does not own terminals:
 * `<TerminalPool/>` renders every panel once, above every layout, and this body
 * shows the one the URL names by adopting its container. Unmounting this body —
 * a layout swap, a view change, a project switch — gives the container back to
 * the pool; the runtime keeps running and the next slot to show it is a
 * visibility flip, not an `/open`, a pty-stream download and a replay.
 *
 * The chip strip is the shared `UnifiedTabStrip` the host renders above it. With
 * no tabs in scope it renders `ProjectHome` (the shared project landing, which
 * owns the spawn openers + their modals).
 */
const TabbedTerminal: React.FC<TabbedTerminalProps> = ({ className = '', scope = 'project', spawnProjectId, processId }) => {
  const { currentDock } = useDockNavigation();
  const allTerminalTabs = useTerminalTabs('all');
  // The project scope decides only the empty landing (no terminals here yet). The
  // subscribed project, not a render-time read of the `dataContext` global.
  const { project } = useContext();
  const scopeProjectId = spawnProjectId === undefined ? (project?.id ?? null) : spawnProjectId;
  const tabs = useMemo(
    () => (scope === 'all' ? allTerminalTabs : allTerminalTabs.filter((tab) => tabInProject(tab, scopeProjectId))),
    [allTerminalTabs, scope, scopeProjectId],
  );

  // Process-scoped host: a process that loaded but carries no shell has nothing
  // to attach to. Hook order is fixed — the entity is subscribed unconditionally
  // and the guard is applied below.
  const hostProcessId = processId
    ? DockPointer.isAgenticProcessPointer(processId)
      ? DockPointer.extractAgenticProcessId(processId)
      : processId
    : null;
  const { data: hostProcess } = useEntity<AgenticProcess>(
    hostProcessId ? new TypeId(AgenticProcess.type, hostProcessId) : null,
  );
  const hostDisconnected = !!hostProcess && !hostProcess.shell_id;

  // Active panel = the URL (every tab is keyed by its dockPointer.tabHash), looked
  // up among ALL terminal tabs: the URL is the truth and the loader already aligned
  // its scope (dock-loading step 3). Checking it against a project-filtered list
  // made a second source of truth — for the render where they disagreed, the tab
  // was "missing" and "This session has nothing to display" flashed.
  const activeKey = currentDock?.tabHash ?? '';
  const activeTab = activeKey ? allTerminalTabs.find((t) => tabKey(t) === activeKey) : undefined;

  // The URL names a session but NO tab backs it (backend refusal, a closed tab):
  // without this arm the slot stays empty and the pane is silently blank — the
  // recorded load error (if any) has no mounted reader.
  const activePointer = currentDock?.pointer ?? '';
  const activeProcessId =
    activePointer && DockPointer.isAgenticProcessPointer(activePointer)
      ? DockPointer.extractAgenticProcessId(activePointer)
      : undefined;
  const activeTabMissing = !!activeKey && tabs.length > 0 && !activeTab;

  // One line per time the dead-end overlay goes up.
  useEffect(() => {
    if (!activeTabMissing) return;
    toplog.log(
      'tab_switch',
      `error ${sinceTabSwitch()} sink=terminal_active_tab_missing key=${activeKey} terminal_tabs=${allTerminalTabs.length}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per appearance
  }, [activeTabMissing, activeKey]);

  const hostRef = useRef<HTMLDivElement>(null);
  const [slot] = useState(() => Symbol('terminal-slot'));
  const shownKey = hostDisconnected || !activeTab ? '' : activeKey;

  // Layout effect: the container is in place before the browser paints, and
  // before the pooled panel's own effects run for a first mount (they measure).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!shownKey || !host) return;
    // Warm = the pool already runs this panel (shown before, by any slot in any
    // layout); cold = this activation mounts it (attach + replay).
    const warm = terminalPool.has(shownKey);
    toplog.log(
      ['tab_switch', 'process_load', 'pty', 'agentic_process.load'],
      `terminal_flip ${sinceTabSwitch()} mode=${warm ? 'warm' : 'cold'} key=${shownKey}`,
    );
    terminalPool.show(slot, shownKey, host);
    return () => terminalPool.hide(slot);
  }, [slot, shownKey]);

  if (hostDisconnected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <span className="text-sm">Disconnected</span>
      </div>
    );
  }

  return (
    <div className={`flex h-full ${className}`}>
      <div className="flex h-full w-full flex-col">
        <div className="relative flex-1 overflow-hidden" data-testid="terminal-panels">
          {/* The slot: the pool appends the shown panel's container here. No React
              children, so React never reconciles against the adopted node. */}
          <div ref={hostRef} className="absolute inset-0" data-testid="terminal-slot" />
          {tabs.length === 0 && (
            <div className="absolute inset-0 z-10 overflow-auto bg-background">
              <ProjectHome spawnProjectId={spawnProjectId} createOnly />
            </div>
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

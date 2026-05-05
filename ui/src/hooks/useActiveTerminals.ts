import { AgenticProcess, isProcessActive, ProcessStatus, QueryFilter, QueryRequest, Shell, ShellStatus } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useEffect, useMemo, useRef } from 'react';

/** Discriminator for tab type */
export type TerminalTabType = 'plain' | 'claude';

/** A merged terminal tab combining Shell + optional AgenticProcess */
export interface TerminalTab {
  shellId: string;
  tabOrder: number;
  name: string | null;
  type: TerminalTabType;
  /** Present when type === 'claude' */
  agenticProcess?: AgenticProcess;
  shell?: Shell;
  /** Whether this tab is disabled while still visible in the tab strip */
  isDisabled: boolean;
  /** Reason string for tooltip when disabled */
  statusReason: string;
}

const HIDDEN_SHELL_STATUSES = new Set([ShellStatus.ERROR]);
const DISABLED_SHELL_STATUSES = new Set([ShellStatus.CLOSED, ShellStatus.CLOSING]);

export interface TabFilter {
  /** When true, hide ERROR shells and sidecar shells (the "visible tab strip" set). */
  visible?: boolean;
  /** When set, only include shells tagged with this collaboration room id. */
  collaborationRoomId?: string | null;
  /**
   * When set, only include tabs whose Shell or linked AgenticProcess has
   * this project_id. Tabs with no project association are dropped.
   */
  projectId?: string | null;
}

/**
 * Pure tab builder. Merges shells + processes into TerminalTab[] and applies
 * the filter. Shared between `useActiveTerminals` (rendering) and the route
 * loaders (default-tab resolution).
 */
export function filterTabs(
  shells: Shell[],
  processes: AgenticProcess[],
  filter: TabFilter = {},
): TerminalTab[] {
  const { visible = false, collaborationRoomId = null, projectId = null } = filter;
  const activeProcesses = processes.filter((p) => isProcessActive(p.status));

  const sidecarShellIds = new Set<string>();
  for (const proc of processes) {
    if (proc.sidecar_shell_id) sidecarShellIds.add(proc.sidecar_shell_id);
  }

  const shellToProcess = new Map<string, AgenticProcess>();
  for (const proc of activeProcesses) {
    if (proc.shell_id) shellToProcess.set(proc.shell_id, proc);
  }

  const keptShells = shells.filter((shell) => {
    if (visible) {
      if (HIDDEN_SHELL_STATUSES.has(shell.status as ShellStatus)) return false;
      if (sidecarShellIds.has(shell.id)) return false;
    }
    if (collaborationRoomId != null && shell.collaboration_room_id !== collaborationRoomId) {
      return false;
    }
    if (projectId != null) {
      const linked = shellToProcess.get(shell.id);
      const tabProjectId = shell.project_id ?? linked?.project_id ?? null;
      if (tabProjectId !== projectId) return false;
    }
    return true;
  });

  const result: TerminalTab[] = keptShells.map((shell) => {
    const linkedProcess = shellToProcess.get(shell.id);
    const isDisabled = DISABLED_SHELL_STATUSES.has(shell.status as ShellStatus);
    const statusReason =
      shell.status === ShellStatus.CLOSING
        ? 'Closing...'
        : shell.status === ShellStatus.CLOSED
          ? 'Closed'
          : '';
    return {
      shellId: shell.id,
      tabOrder: shell.tab_order ?? 0,
      name: shell.name ?? null,
      type: linkedProcess ? 'claude' : 'plain',
      agenticProcess: linkedProcess,
      shell,
      isDisabled,
      statusReason,
    };
  });

  result.sort((a, b) => a.tabOrder - b.tabOrder);
  return result;
}

const shellQuery = new QueryRequest({
  type: 'shell',
  scope: [],
  name: 'useActiveTerminals:shells',
  query: new QueryFilter({ match: { op: '$NE', operands: ['status', ShellStatus.CLOSED] } as Record<string, unknown> }),
});

const processQuery = new QueryRequest({
  type: 'agentic_process',
  scope: [],
  name: 'useActiveTerminals:processes',
  query: new QueryFilter({ match: { visible: true } as Record<string, unknown> }),
});

/**
 * Hook that queries Shell and AgenticProcess entities, merges them into an
 * ordered tab list.
 *
 * Pass `collaborationRoomId` to scope tabs to a specific collaboration room
 * (only shells that have been explicitly shared into that room appear).
 */
export interface UseActiveTerminalsOptions {
  collaborationRoomId?: string | null;
  /** When set, only return tabs whose shell/process belongs to this project_id. */
  projectId?: string | null;
}

export function useActiveTerminals(options: UseActiveTerminalsOptions = {}) {
  const { collaborationRoomId = null, projectId = null } = options;
  const { data: shells = [], isLoading: shellsLoading } = useEntitiesQuery<Shell>(shellQuery);
  const { data: processes = [], isLoading: processesLoading } =
    useEntitiesQuery<AgenticProcess>(processQuery);
  const shellProjectionKey = shells
    .map((shell) => `${shell.id}:${shell.status ?? ''}:${shell.error_message ?? ''}:${shell.name ?? ''}:${shell.tab_order ?? 0}:${shell.collaboration_room_id ?? ''}:${shell.project_id ?? ''}`)
    .join('|');
  const processProjectionKey = processes
    .map((process) => `${process.id}:${process.status ?? ''}:${process.shell_id ?? ''}:${process.sidecar_shell_id ?? ''}:${process.project_id ?? ''}`)
    .join('|');

  // Refs keep the latest arrays accessible without adding them as useMemo deps.
  // The projection keys already encode all fields that affect tab identity/ordering,
  // so re-running the memo on array-reference changes alone was producing new tab
  // arrays with identical content, cascading through every callback and useEffect
  // that depends on `sessions` (navigateToSession → selectTab → scroll effects).
  const shellsRef = useRef(shells);
  shellsRef.current = shells;
  const processesRef = useRef(processes);
  processesRef.current = processes;

  const tabs = useMemo(() => {
    return filterTabs(shellsRef.current, processesRef.current, {
      visible: true,
      collaborationRoomId,
      projectId,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellProjectionKey, processProjectionKey, collaborationRoomId, projectId]);

  // Cleanup stuck STOPPING processes from the client. After a 10s debounce
  // (so a live close() has time to finish naturally), check each STOPPING
  // row's actual liveness via os-status; if the worker is demonstrably
  // gone, write STOPPED directly via the entity's save() path. Imperfect
  // (race window between the os-status read and the save), but pragmatic —
  // we don't have a server-side reconciler.
  const stuckKey = processes
    .filter((p) => p.status === ProcessStatus.STOPPING)
    .map((p) => p.id)
    .sort()
    .join('|');
  useEffect(() => {
    if (!stuckKey) return;
    const stuckIds = stuckKey.split('|');
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        for (const id of stuckIds) {
          if (cancelled) return;
          const proc = processesRef.current.find((p) => p.id === id);
          if (!proc || proc.status !== ProcessStatus.STOPPING) continue;
          try {
            const status = await proc.getOsStatus();
            if (cancelled) return;
            if (!status.has_attachable_pty && !status.worker_alive) {
              proc.status = ProcessStatus.STOPPED;
              await proc.save();
            }
          } catch {
            // best-effort cleanup; swallow per-process errors
          }
        }
      })();
    }, 10_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [stuckKey]);

  const isLoading = shellsLoading || processesLoading;

  return { tabs, isLoading };
}

import { AgenticProcess, isProcessActive, QueryFilter, QueryRequest, Shell, ShellStatus } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { useMemo, useRef } from 'react';

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
 * Pass `collaborationSessionId` to scope tabs to a specific collaboration space
 * (only shells that have been explicitly shared into that space appear).
 */
export interface UseActiveTerminalsOptions {
  collaborationSessionId?: string | null;
}

export function useActiveTerminals(options: UseActiveTerminalsOptions = {}) {
  const { collaborationSessionId = null } = options;
  const { data: shells = [], isLoading: shellsLoading } = useEntitiesQuery<Shell>(shellQuery);
  const { data: processes = [], isLoading: processesLoading } =
    useEntitiesQuery<AgenticProcess>(processQuery);
  const shellProjectionKey = shells
    .map((shell) => `${shell.id}:${shell.status ?? ''}:${shell.error_message ?? ''}:${shell.name ?? ''}:${shell.tab_order ?? 0}:${shell.collaboration_session_id ?? ''}`)
    .join('|');
  const processProjectionKey = processes
    .map((process) => `${process.id}:${process.status ?? ''}:${process.shell_id ?? ''}:${process.sidecar_shell_id ?? ''}`)
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
    const currentShells = shellsRef.current;
    const currentProcesses = processesRef.current;
    const activeProcesses = currentProcesses.filter((p) => isProcessActive(p.status));

    // Build a set of sidecar shell IDs — these are internal-only PTY sessions
    // managed by InteractiveTerminal and must not appear as top-level tabs.
    const sidecarShellIds = new Set<string>();
    for (const proc of currentProcesses) {
      if (proc.sidecar_shell_id) sidecarShellIds.add(proc.sidecar_shell_id);
    }

    const visibleShells = currentShells.filter((shell) => {
      if (HIDDEN_SHELL_STATUSES.has(shell.status as ShellStatus)) return false;
      if (sidecarShellIds.has(shell.id)) return false;
      if (collaborationSessionId != null && shell.collaboration_session_id !== collaborationSessionId) return false;
      return true;
    });

    // Build map: shell_id -> AgenticProcess
    const shellToProcess = new Map<string, AgenticProcess>();
    for (const proc of activeProcesses) {
      if (proc.shell_id) {
        shellToProcess.set(proc.shell_id, proc);
      }
    }

    // Build tabs from shells that should still be visible in the terminal strip.
    const result: TerminalTab[] = visibleShells.map((shell) => {
      const linkedProcess = shellToProcess.get(shell.id);
      const isDisabled = DISABLED_SHELL_STATUSES.has(shell.status as ShellStatus);
      const statusReason = shell.status === ShellStatus.CLOSING ? 'Closing...'
        : shell.status === ShellStatus.CLOSED ? 'Closed'
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

    // Sort by tab_order
    result.sort((a, b) => a.tabOrder - b.tabOrder);

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shellProjectionKey, processProjectionKey, collaborationSessionId]);

  const isLoading = shellsLoading || processesLoading;

  return { tabs, isLoading };
}

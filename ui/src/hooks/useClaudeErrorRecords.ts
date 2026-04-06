import { ActionInfo, AgenticProcess, dataContext, dataManager, Task } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { useCallback, useMemo, useState } from 'react';
import { v5 as uuidv5 } from 'uuid';
import { useAction } from './use-action';
import { useContext } from './useContext';

// ─── Constants & Types ───────────────────────────────────────────────────────

export const ErrorStatus = {
  OPEN: 'open',
  IGNORED: 'ignored',
  IGNORED_UNTIL: 'ignored_until',
  TASK_CREATED: 'task_created',
} as const;
export type ErrorStatus = (typeof ErrorStatus)[keyof typeof ErrorStatus];

export const ErrorCategory = {
  HOOK: 'hook',
  LOG: 'log',
} as const;
export type ErrorCategory = (typeof ErrorCategory)[keyof typeof ErrorCategory];

// ─── Filter state (shared via localStorage) ─────────────────────────────────

export type ErrorTimeSpan = '1m' | '1h' | '24h' | '1w' | 'all';

export const ERROR_TIME_SPANS: { value: ErrorTimeSpan; ms: number; label: string; tooltip: string }[] = [
  { value: '1m', ms: 60_000, label: '1m', tooltip: 'Last 1 minute' },
  { value: '1h', ms: 3_600_000, label: '1h', tooltip: 'Last 1 hour' },
  { value: '24h', ms: 86_400_000, label: '24h', tooltip: 'Last 24 hours' },
  { value: '1w', ms: 604_800_000, label: '1w', tooltip: 'Last 1 week' },
  { value: 'all', ms: Infinity, label: 'All', tooltip: 'All time' },
];

const STORAGE_KEYS = {
  timeSpan: 'flowpad-error-timespan',
  statusFilter: 'flowpad-error-status',
  deduplicate: 'flowpad-error-dedup',
} as const;

function loadStoredTimeSpan(): ErrorTimeSpan {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.timeSpan);
    if (v && ERROR_TIME_SPANS.some((t) => t.value === v)) return v as ErrorTimeSpan;
  } catch {
    /* ignore */
  }
  return '24h';
}

function loadStoredStatusFilter(): ErrorStatus | 'all' {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.statusFilter);
    if (v === 'all' || Object.values(ErrorStatus).includes(v as ErrorStatus)) return v as ErrorStatus | 'all';
  } catch {
    /* ignore */
  }
  return ErrorStatus.OPEN;
}

function loadStoredDeduplicate(): boolean {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.deduplicate);
    if (v !== null) return v !== 'false';
  } catch {
    /* ignore */
  }
  return true;
}

/** Result from the Flowpad cloud known-issues search. */
export interface CloudSearchResult {
  fingerprint: string;
  /** "fix" = a tested fix instruction is available; "ignore" = safe to ignore; "analyse" = no known resolution */
  action: 'ignore' | 'fix' | 'analyse';
  instruction: string | null;
  message: string | null;
}

/** Cloud fix suggestion */
export interface Fix {
  instruction: string;
  message: string;
}

export interface ErrorOccurrence {
  timestamp: string;
  session_id: string;
  jsonl_path: string;
  error_msg: string;
  traceback: string[];
  hook?: string;
  event?: string;
}

export interface ClaudeErrorRecord {
  id: string;
  type: string;
  name: string;
  fingerprint: string;
  error_category: ErrorCategory;
  error_msg: string;
  hook: string;
  event: string;
  hooks: string[];  // all distinct hook names seen across occurrences
  root_cause: string;
  traceback: string[];
  occurrence_count: number;
  first_seen: string;
  last_seen: string;
  session_ids: string[];
  last_session_id: string;
  last_jsonl_path: string;
  occurrences: ErrorOccurrence[];
  error_status: ErrorStatus;
  ignored_until: string;
  linked_task_id: string;
  worker_session_id: string;
  claude_session_id: string;
  triaged_at: string;
  notes: string;
  fix: Fix;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useClaudeErrorRecords() {
  const { computeNode } = useContext();
  const { project } = useProject();
  const projectTypeId = project?.typeId;

  const actionInfo = useMemo(() => {
    if (!computeNode?.typeId?.id) return null;
    const info = new ActionInfo('fs-records', 'compute_node', computeNode.typeId.id, 'GET');
    info.subpath = 'claude_error';
    return info;
  }, [computeNode?.typeId?.id]);

  const { data, isLoading, refetch } = useAction<ClaudeErrorRecord[]>(actionInfo, {
    enabled: !!computeNode?.typeId?.id,
  });

  const allErrors = useMemo(() => {
    if (!data || !Array.isArray(data)) return [];
    // Deduplicate by fingerprint (WS push + refetch can cause transient duplicates).
    // Keep the latest version of each record.
    const byFp = new Map<string, ClaudeErrorRecord>();
    for (const e of data) {
      const existing = byFp.get(e.fingerprint);
      if (!existing || e.last_seen > existing.last_seen) byFp.set(e.fingerprint, e);
    }
    // Sort newest last_seen first
    return [...byFp.values()].sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  }, [data]);

  // ─── Shared filter state (persisted to localStorage) ──────────────────

  const [timeSpan, _setTimeSpan] = useState<ErrorTimeSpan>(loadStoredTimeSpan);
  const [statusFilter, _setStatusFilter] = useState<ErrorStatus | 'all'>(loadStoredStatusFilter);
  const [deduplicate, _setDeduplicate] = useState<boolean>(loadStoredDeduplicate);

  const setTimeSpan = useCallback((v: ErrorTimeSpan) => {
    _setTimeSpan(v);
    try {
      localStorage.setItem(STORAGE_KEYS.timeSpan, v);
    } catch {
      /* ignore */
    }
  }, []);

  const setStatusFilter = useCallback((v: ErrorStatus | 'all') => {
    _setStatusFilter(v);
    try {
      localStorage.setItem(STORAGE_KEYS.statusFilter, v);
    } catch {
      /* ignore */
    }
  }, []);

  const setDeduplicate = useCallback((v: boolean) => {
    _setDeduplicate(v);
    try {
      localStorage.setItem(STORAGE_KEYS.deduplicate, String(v));
    } catch {
      /* ignore */
    }
  }, []);

  // ─── Derived counts ─────────────────────────────────────────────────

  const spanMs = ERROR_TIME_SPANS.find((t) => t.value === timeSpan)?.ms ?? Infinity;

  const filteredErrors = useMemo(() => {
    const cutoff = spanMs === Infinity ? 0 : Date.now() - spanMs;
    return allErrors.filter((e) => {
      if (e.last_seen && cutoff > 0 && new Date(e.last_seen).getTime() < cutoff) return false;
      if (statusFilter !== 'all' && e.error_status !== statusFilter) return false;
      return true;
    });
  }, [allErrors, spanMs, statusFilter]);

  const displayCount = useMemo(() => {
    if (deduplicate) return filteredErrors.length;
    const cutoff = spanMs === Infinity ? 0 : Date.now() - spanMs;
    return filteredErrors.reduce((sum, e) => {
      if (!e.occurrences?.length) return sum + 1;
      return (
        sum +
        e.occurrences.filter((occ) => {
          if (cutoff === 0) return true;
          return !occ.timestamp || new Date(occ.timestamp).getTime() >= cutoff;
        }).length
      );
    }, 0);
  }, [filteredErrors, deduplicate, spanMs]);

  /** Badge counter: always reflects OPEN errors in the last 24h, independent of viewer filter. */
  const openDisplayCount = useMemo(() => {
    const badgeSpanMs = 86_400_000; // fixed 24h — not tied to the viewer's time filter
    const cutoff = Date.now() - badgeSpanMs;
    const openInRange = allErrors.filter((e) => {
      if (e.error_status !== ErrorStatus.OPEN) return false;
      if (e.last_seen && new Date(e.last_seen).getTime() < cutoff) return false;
      return true;
    });
    if (deduplicate) return openInRange.length;
    return openInRange.reduce((sum, e) => {
      if (!e.occurrences?.length) return sum + 1;
      return (
        sum +
        e.occurrences.filter((occ) => {
          return !occ.timestamp || new Date(occ.timestamp).getTime() >= cutoff;
        }).length
      );
    }, 0);
  }, [allErrors, deduplicate]);

  /** Per-status counts respecting the current time span and deduplicate filters (for tab badges). */
  const statusCounts = useMemo(() => {
    const cutoff = spanMs === Infinity ? 0 : Date.now() - spanMs;
    const counts: Record<string, number> = { all: 0 };
    for (const status of Object.values(ErrorStatus)) counts[status] = 0;

    for (const e of allErrors) {
      if (e.last_seen && cutoff > 0 && new Date(e.last_seen).getTime() < cutoff) continue;
      if (deduplicate) {
        counts.all++;
        counts[e.error_status] = (counts[e.error_status] || 0) + 1;
      } else {
        const occCount = e.occurrences?.length
          ? e.occurrences.filter((occ) => cutoff === 0 || !occ.timestamp || new Date(occ.timestamp).getTime() >= cutoff).length
          : 1;
        counts.all += occCount;
        counts[e.error_status] = (counts[e.error_status] || 0) + occCount;
      }
    }
    return counts;
  }, [allErrors, spanMs, deduplicate]);

  // ─── Mutation helpers ──────────────────────────────────────────────────

  const _mutate = useCallback(
    async (fingerprint: string, updates: Record<string, unknown>) => {
      if (!computeNode?.typeId?.id) return;
      const recordId = uuidv5(`claude_error:${fingerprint}`, uuidv5.DNS);
      const info = new ActionInfo('fs-records', 'compute_node', computeNode.typeId.id, 'PUT');
      info.subpath = `claude_error/${recordId}`;
      info.bodyParameters = updates;
      info.queryParameters = { _: '1' }; // required by callAction for PUT
      await dataManager.callAction(info);
      await refetch();
    },
    [computeNode?.typeId?.id, refetch],
  );

  const ignoreAll = useCallback(
    (fingerprint: string) =>
      _mutate(fingerprint, {
        error_status: ErrorStatus.IGNORED,
        triaged_at: new Date().toISOString(),
      }),
    [_mutate],
  );

  const ignoreTillNow = useCallback(
    (fingerprint: string) =>
      _mutate(fingerprint, {
        error_status: ErrorStatus.IGNORED_UNTIL,
        ignored_until: new Date().toISOString(),
        triaged_at: new Date().toISOString(),
      }),
    [_mutate],
  );

  const ignoreUntil = useCallback(
    (fingerprint: string, until: Date) =>
      _mutate(fingerprint, {
        error_status: ErrorStatus.IGNORED_UNTIL,
        ignored_until: until.toISOString(),
        triaged_at: new Date().toISOString(),
      }),
    [_mutate],
  );

  const reopenError = useCallback(
    (fingerprint: string) =>
      _mutate(fingerprint, {
        error_status: ErrorStatus.OPEN,
        ignored_until: '',
        triaged_at: new Date().toISOString(),
      }),
    [_mutate],
  );

  const linkTask = useCallback(
    (fingerprint: string, taskId: string) =>
      _mutate(fingerprint, {
        error_status: ErrorStatus.TASK_CREATED,
        linked_task_id: taskId,
        triaged_at: new Date().toISOString(),
      }),
    [_mutate],
  );

  const createTaskForError = useCallback(
    async (
      error: ClaudeErrorRecord,
      options?: { instruction?: string },
    ): Promise<{ taskId: string | null; shellId: string | null }> => {
      if (!projectTypeId) return { taskId: null, shellId: null };
      try {
        const task = new Task({
          title: `Fix: ${error.error_msg.slice(0, 60)}`,
          description: [
            `Error fingerprint: ${error.fingerprint}`,
            `Category: ${error.error_category}`,
            error.hook ? `Hook: ${error.hook} (${error.event})` : '',
            error.root_cause ? `Root cause: ${error.root_cause}` : '',
            `Seen ${error.occurrence_count} time(s) across ${error.session_ids.length} session(s)`,
            `First seen: ${error.first_seen}`,
            `Last seen: ${error.last_seen}`,
          ]
            .filter(Boolean)
            .join('\n'),
          status: 'to_do',
          task_type: 'task',
          priority: 'high',
          tags: ['error', error.error_category],
          metadata: {
            errorFingerprint: error.fingerprint,
            errorCategory: error.error_category,
            hook: error.hook,
            event: error.event,
          },
        });
        await task.save([projectTypeId]);
        const taskId = task.id;

        const workdir =
          project?.fs_storage_mount_path ||
          project?.name ||
          dataContext.bootstrapInfo?.desktop_info?.paths?.workspace ||
          undefined;

        const cleanMsg = error.error_msg.replace(/^(Error:\s+)+/i, '');
        const errorDetails = [
          `Error: ${cleanMsg}`,
          error.error_category === ErrorCategory.HOOK ? `Hook: ${error.hook} (${error.event})` : '',
          error.root_cause ? `Root cause: ${error.root_cause}` : '',
          error.traceback?.length ? `\nTraceback:\n${error.traceback.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        const instruction =
          options?.instruction ??
          `Investigate this error. Analyze the issue, find root cause and solution, explain them to the user and fix the error if it is possible\n\n${errorDetails}`;

        const { process, shell } = await AgenticProcess.spawn(
          { permissionMode: 'bypassPermissions', workdir },
          { instruction },
        );

        const shellId = shell?.id ?? null;

        if (taskId) {
          await _mutate(error.fingerprint, {
            error_status: ErrorStatus.TASK_CREATED,
            linked_task_id: taskId,
            worker_session_id: shellId ?? '',
            claude_session_id: process.worker_session_id ?? '',
            triaged_at: new Date().toISOString(),
          });
        }
        return { taskId: taskId ?? null, shellId };
      } catch (e) {
        console.error('[useClaudeErrorRecords] Failed to create task:', e);
        return { taskId: null, shellId: null };
      }
    },
    [projectTypeId, project, _mutate],
  );

  /** Delete all debug logs and error records. Returns summary. */
  const clearAll = useCallback(async () => {
    if (!computeNode?.typeId?.id) return null;
    const info = new ActionInfo('clear-debug-errors', 'compute_node', computeNode.typeId.id, 'POST');
    const result = await dataManager.callAction<unknown, {
      deleted_debug_logs: number;
      truncated_debug_logs: number;
      skipped_debug_logs: string[];
      deleted_error_records: number;
    }>(info);
    await refetch();
    return result ?? null;
  }, [computeNode?.typeId?.id, refetch]);

  /**
   * Query the Flowpad cloud known-issues database for a batch of fingerprints.
   * The server applies results (ignore / save fix) to local records automatically.
   * Returns one result per fingerprint with action: 'fix' | 'ignore' | 'analyse'.
   */
  const searchCloudForErrors = useCallback(
    async (fingerprints: string[]): Promise<CloudSearchResult[]> => {
      if (!computeNode?.typeId?.id || fingerprints.length === 0) return [];
      const info = new ActionInfo('search-cloud-errors', 'compute_node', computeNode.typeId.id, 'POST');
      info.bodyParameters = { fingerprints };
      const result = await dataManager.callAction<string[], { results: CloudSearchResult[] }>(info);
      await refetch();
      return result?.results ?? [];
    },
    [computeNode?.typeId?.id, refetch],
  );

  /**
   * Spawn an AgenticProcess for each fingerprint using the cloud fix instruction stored on the record.
   * Returns per-fingerprint spawn results from the server.
   */
  const fixAllCloud = useCallback(
    async (fingerprints: string[]): Promise<Array<{ fingerprint: string; status: string; shell_id?: string; worker_session_id?: string }>> => {
      if (!computeNode?.typeId?.id || fingerprints.length === 0) return [];
      const info = new ActionInfo('fix-all-cloud-errors', 'compute_node', computeNode.typeId.id, 'POST');
      info.bodyParameters = { fingerprints };
      const result = await dataManager.callAction<unknown, { spawned: Array<{ fingerprint: string; status: string; shell_id?: string; worker_session_id?: string }> }>(info);
      await refetch();
      return result?.spawned ?? [];
    },
    [computeNode?.typeId?.id, refetch],
  );

  return {
    allErrors,
    filteredErrors,
    displayCount,
    openDisplayCount,
    // Filter state
    timeSpan,
    setTimeSpan,
    statusFilter,
    setStatusFilter,
    deduplicate,
    setDeduplicate,
    spanMs,
    // Data state
    isLoading,
    refetch,
    statusCounts,
    // Triage actions
    ignoreAll,
    ignoreTillNow,
    ignoreUntil,
    reopenError,
    linkTask,
    createTaskForError,
    clearAll,
    // Cloud search
    searchCloudForErrors,
    fixAllCloud,
  };
}

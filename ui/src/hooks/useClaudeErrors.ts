import { ActionInfo } from '@sdk';
import { useMemo } from 'react';
import { useAction } from './use-action';
import { useContext } from './useContext';

export interface ClaudeHookError {
  hook: string;
  event: string;
  timestamp: string;
  traceback: string[];
  root_cause: string;
}

export interface ClaudeLogError {
  timestamp: string;
  message: string;
}

export interface ClaudeDebugLogRecord {
  id: string;
  type: string;
  session_id: string;
  has_errors: boolean;
  error_count: number;
  hook_errors: ClaudeHookError[];
  log_errors: ClaudeLogError[];
  log_error_count: number;
  jsonl_path: string;
}

type ClaudeDebugLogResponse = ClaudeDebugLogRecord[];

export interface FlatHookError extends ClaudeHookError {
  session_id: string;
  jsonl_path: string;
}

export interface FlatLogError extends ClaudeLogError {
  session_id: string;
  jsonl_path: string;
}

export function useClaudeErrors() {
  const { computeNode } = useContext();

  const actionInfo = useMemo(() => {
    if (!computeNode?.typeId?.id) return null;
    const info = new ActionInfo('fs-records', 'compute_node', computeNode.typeId.id, 'GET');
    info.subpath = 'claude_debug_log';
    return info;
  }, [computeNode?.typeId?.id]);

  const { data, isLoading, refetch } = useAction<ClaudeDebugLogResponse>(actionInfo, {
    enabled: !!computeNode?.typeId?.id,
  });

  const { hookErrors, logErrors, errorCount } = useMemo(() => {
    if (!data || !Array.isArray(data))
      return { hookErrors: [] as FlatHookError[], logErrors: [] as FlatLogError[], errorCount: 0 };

    const hooks: FlatHookError[] = [];
    const logs: FlatLogError[] = [];
    for (const record of data) {
      const common = { session_id: record.session_id, jsonl_path: record.jsonl_path };
      if (record.hook_errors) {
        for (const err of record.hook_errors) {
          hooks.push({ ...err, ...common });
        }
      }
      if (record.log_errors) {
        for (const err of record.log_errors) {
          logs.push({ ...err, ...common });
        }
      }
    }
    // Sort newest first (backend returns sessions newest-first,
    // but errors within sessions are in file order — reverse them)
    const byTimestampDesc = (a: { timestamp: string }, b: { timestamp: string }) =>
      b.timestamp.localeCompare(a.timestamp);
    hooks.sort(byTimestampDesc);
    logs.sort(byTimestampDesc);
    return { hookErrors: hooks, logErrors: logs, errorCount: hooks.length + logs.length };
  }, [data]);

  return { hookErrors, logErrors, errorCount, isLoading, refetch };
}

import { ActionInfo } from '@sdk';
import type { ClaudeSessionRecordData } from '@sdk/resource_management/fs_records/claude/claude-session';
import { useMemo } from 'react';
import { useAction } from './use-action';
import { useContext } from './useContext';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HistoryEntryResponse {
  id: string;
  type: string;
  name: string;
  display: string;
  timestamp_ms: number;
  project: string;
  session_id: string;
  session_ref?: { id: string; type: string };
  _session?: ClaudeSessionRecordData;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useClaudeHistory(limit = 20) {
  const { computeNode } = useContext();

  const actionInfo = useMemo(() => {
    if (!computeNode?.typeId?.id) return null;
    const info = new ActionInfo('fs-records', 'compute_node', computeNode.typeId.id, 'GET');
    info.subpath = 'history_entry';
    info.queryParameters = {
      sort_by: 'timestamp_ms',
      sort_desc: 'true',
      limit: String(limit),
      include: 'claude_session',
    };
    return info;
  }, [computeNode?.typeId?.id, limit]);

  const { data, isLoading, refetch } = useAction<HistoryEntryResponse[]>(actionInfo, {
    enabled: !!computeNode?.typeId?.id,
  });

  const entries = useMemo(() => {
    if (!data || !Array.isArray(data)) return [];
    return data; // Already sorted by backend
  }, [data]);

  return { entries, isLoading, refetch };
}

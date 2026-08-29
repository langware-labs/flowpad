import { useMemo } from 'react';
import { useWorkerHistory } from '@src/hooks/useWorkerHistory';
import { workerHistoryToRow } from './adapters';
import type { SpotlightInitialInfo } from './types';

const HISTORY_LIMIT = 50;

export function useTerminalInitialRows(open: boolean): SpotlightInitialInfo {
  const { entries, isLoading } = useWorkerHistory(HISTORY_LIMIT, { enabled: open });
  const rows = useMemo(() => {
    // Empty chats are already gone (useWorkerHistory) — nothing downstream could
    // spot them anyway, since `workerHistoryToRow` drops every emptiness signal.
    return entries
      .slice()
      .sort((a, b) => {
        const ta = a.last_active_time ? Date.parse(a.last_active_time) : 0;
        const tb = b.last_active_time ? Date.parse(b.last_active_time) : 0;
        return tb - ta;
      })
      .map(workerHistoryToRow);
  }, [entries]);
  return { rows, isLoading };
}

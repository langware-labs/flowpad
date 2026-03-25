import type { VirtualTerminal, RowSyncData } from '@sdk/pty-sync/simulator/VirtualTerminal.js';
import { useMemo } from 'react';

export type { RowSyncData };

export function useTimeGutter(
  vt: VirtualTerminal | null | undefined,
  viewportY: number,
  rows: number,
  version: number,
): RowSyncData[] {
  return useMemo(() => {
    if (!vt || rows <= 0) return [];
    return vt.getRowDataRange(viewportY, rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vt, viewportY, rows, version]);
}

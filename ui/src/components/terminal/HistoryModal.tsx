import { AgenticProcess, QueryFilter, QueryRequest } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import React, { useMemo } from 'react';

function timeAgo(date: Date | string | number | undefined | null): string {
  if (!date) return '—';
  const d = typeof date === 'number' ? new Date(date) : typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const closedQuery = new QueryRequest({
  type: 'agentic_process',
  scope: [],
  name: 'closedAgenticProcesses',
  query: new QueryFilter({
    match: {
      op: '$OR',
      operands: [
        { op: '$EQ', operands: ['status', 'stopped'] },
        { op: '$EQ', operands: ['status', 'failed'] },
      ],
    } as Record<string, unknown>,
    order_by: { updated_date: 'desc' },
  }),
});

export function useClosedAgenticProcesses(): AgenticProcess[] {
  const { data = [] } = useEntitiesQuery<AgenticProcess>(closedQuery);
  return useMemo(
    () =>
      data
        .filter((p) => p.session_id != null)
        .sort((a, b) => {
          const ta = a.updated_date ? new Date(a.updated_date).getTime() : 0;
          const tb = b.updated_date ? new Date(b.updated_date).getTime() : 0;
          return tb - ta;
        })
        .slice(0, 10),
    [data],
  );
}

interface HistoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (process: AgenticProcess) => void;
}

export function HistoryModal({ open, onOpenChange, onSelect }: HistoryModalProps) {
  const processes = useClosedAgenticProcesses();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">Recent Sessions</DialogTitle>
        </DialogHeader>
        {processes.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">No recent closed sessions</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {processes.map((p) => (
              <li key={p.id}>
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => onSelect(p)}
                >
                  <ClaudeIcon className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                  <span className="min-w-0 flex-1 truncate font-medium">{p.name ?? p.session_id ?? p.id}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(p.updated_date)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

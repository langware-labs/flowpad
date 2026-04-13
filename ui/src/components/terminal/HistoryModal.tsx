import { AgenticProcess, QueryFilter, QueryRequest } from '@sdk';
import type { IDockPointer } from '@sdk';
import type { ClaudeSessionRecordData } from '@sdk/resource_management/fs_records/claude/claude-session';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { useResources } from '@src/hooks/use-resources';
import { SystemResourceType } from '@src/store/resource-manager';
import React, { useEffect, useMemo, useState } from 'react';

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

export interface RecentItem {
  id: string;
  name: string;
  time: Date;
  dockPointer: IDockPointer;
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

export function useRecentSessions(limit = 10): RecentItem[] {
  const { data: processes = [] } = useEntitiesQuery<AgenticProcess>(closedQuery);
  const { items: sessions } = useResources<ClaudeSessionRecordData>(SystemResourceType.SESSION, { limit: 20 });

  // session_ids already covered by an agentic_process entry
  const processSessionIds = useMemo(
    () => new Set(processes.map((p) => p.session_id).filter(Boolean)),
    [processes],
  );

  // Async-resolved dockPointers for orphan claude_sessions (no linked agentic_process)
  const [orphanItems, setOrphanItems] = useState<RecentItem[]>([]);

  useEffect(() => {
    const orphans = sessions.filter((s) => s.session_id && !processSessionIds.has(s.session_id));
    if (orphans.length === 0) {
      setOrphanItems([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const resolved: RecentItem[] = [];
      for (const s of orphans) {
        try {
          const p = await AgenticProcess.fromClaudeSession(s.session_id);
          if (!cancelled && p) {
            resolved.push({
              id: s.id,
              name: s.name ?? s.session_id,
              time: new Date(s.modified_at ?? 0),
              dockPointer: p.dockPointer,
            });
          }
        } catch {
          // skip unresolvable sessions
        }
      }
      if (!cancelled) setOrphanItems(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessions, processSessionIds]);

  return useMemo(() => {
    const processItems: RecentItem[] = processes
      .filter((p) => p.session_id != null)
      .map((p) => ({
        id: p.id,
        name: p.name ?? p.session_id ?? p.id,
        time: new Date(p.updated_date ?? 0),
        dockPointer: p.dockPointer,
      }));

    return [...processItems, ...orphanItems]
      .sort((a, b) => b.time.getTime() - a.time.getTime())
      .slice(0, limit);
  }, [processes, orphanItems, limit]);
}

interface HistoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (item: RecentItem) => void;
}

export function HistoryModal({ open, onOpenChange, onSelect }: HistoryModalProps) {
  const items = useRecentSessions();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">Recent Sessions</DialogTitle>
        </DialogHeader>
        {items.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">No recent closed sessions</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {items.map((item) => (
              <li key={item.id}>
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => onSelect(item)}
                >
                  <ClaudeIcon className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                  <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(item.time)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

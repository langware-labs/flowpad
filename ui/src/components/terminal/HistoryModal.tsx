import { AgenticProcess, QueryFilter, QueryRequest } from '@sdk';
import type { IDockPointer } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { useClaudeHistory } from '@src/hooks/useClaudeHistory';
import React, { useEffect, useMemo, useState } from 'react';

const LIMIT = 10;
const HISTORY_FETCH = 20;

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

const processQuery = new QueryRequest({
  type: 'agentic_process',
  scope: [],
  name: 'recentAgenticProcesses',
  query: new QueryFilter({
    order_by: { updated_date: 'desc' },
  }),
});

export function useRecentSessions(): RecentItem[] {
  // List 1: last N agentic_process entities across all projects
  const { data: processes = [] } = useEntitiesQuery<AgenticProcess>(processQuery);

  // List 2: last N entries from ~/.claude/history.jsonl across all projects
  const { entries: historyEntries } = useClaudeHistory(HISTORY_FETCH);

  // Resolve dockPointers for all history entries up front.
  // Effect only depends on historyEntries — NOT on processes — so that
  // fromClaudeSession upserts don't retrigger the effect and cause a loop.
  const [historyItems, setHistoryItems] = useState<RecentItem[]>([]);

  useEffect(() => {
    if (historyEntries.length === 0) {
      setHistoryItems([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const resolved: RecentItem[] = [];
      for (const entry of historyEntries) {
        if (!entry.session_id) continue;
        try {
          const p = await AgenticProcess.fromClaudeSession(entry.session_id);
          if (!cancelled && p) {
            resolved.push({
              id: entry.session_id,
              name: entry.name || entry.display || entry.session_id,
              time: new Date(entry.timestamp_ms),
              dockPointer: p.dockPointer,
            });
          }
        } catch {
          // skip unresolvable sessions
        }
      }
      if (!cancelled) setHistoryItems(resolved);
    })();
    return () => {
      cancelled = true;
    };
  }, [historyEntries]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    // Both sources use session_id as the canonical key so dedup works across types.
    // Build a display-text lookup from history so process entries can fall back to prompt text.
    const historyDisplayMap = new Map(historyItems.map((h) => [h.id, h.name]));

    const processItems: RecentItem[] = processes
      .filter((p) => p.session_id != null)
      .map((p) => ({
        id: p.session_id!,
        name: p.name || historyDisplayMap.get(p.session_id!) || p.session_id!,
        time: new Date(p.updated_date ?? 0),
        dockPointer: p.dockPointer,
      }));

    // Merge, sort, then deduplicate by id (prefer the first/latest occurrence).
    const seen = new Set<string>();
    return [...processItems, ...historyItems]
      .sort((a, b) => b.time.getTime() - a.time.getTime())
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .slice(0, LIMIT);
  }, [processes, historyItems]);
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
      <DialogContent className="w-full max-w-sm overflow-hidden p-4">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">Recent Sessions</DialogTitle>
        </DialogHeader>
        {items.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">No recent sessions</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5 overflow-hidden">
            {items.map((item) => (
              <li key={item.id} className="min-w-0">
                <button
                  className="flex w-full min-w-0 items-center gap-2 overflow-hidden rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => onSelect(item)}
                >
                  <ClaudeIcon className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                  <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">{timeAgo(item.time)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

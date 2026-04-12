import { AgenticProcess, APIEntity, QueryFilter, QueryRequest, registerEntity } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { IEntity } from '@sdk/IEntity';
import React, { useMemo } from 'react';

/** Minimal entity wrapper so EntityFactory can deserialize claude_session responses. */
class ClaudeSession extends APIEntity<ClaudeSession> {
  static override type = 'claude_session';
  name?: string | null;
  cwd?: string | null;

  constructor(entity: Partial<IEntity & { name?: string; cwd?: string }> = {}) {
    super(entity);
    this.name = (entity as any).name ?? null;
    this.cwd = (entity as any).cwd ?? null;
  }
}
registerEntity(ClaudeSession);

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

const closedProcessQuery = new QueryRequest({
  type: 'agentic_process',
  scope: [],
  name: 'historyClosedProcesses',
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

const sessionQuery = new QueryRequest({
  type: 'claude_session',
  scope: [],
  name: 'historyClaudeSessions',
  query: new QueryFilter({ limit: 50, order_by: { updated_date: 'desc' } }),
});

export interface HistoryEntry {
  key: string;
  displayName: string;
  updatedAt: number;
  processId?: string;   // set when a stopped AgenticProcess exists for this session
  sessionId: string;    // always the claude_session UUID
}

export function useHistoryEntries(): HistoryEntry[] {
  const { data: closedProcesses = [] } = useEntitiesQuery<AgenticProcess>(closedProcessQuery);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawSessions = [] } = useEntitiesQuery<any>(sessionQuery as any);

  return useMemo(() => {
    const entries = new Map<string, HistoryEntry>();

    // Seed from stopped/failed processes (keyed by session_id)
    for (const p of closedProcesses) {
      if (!p.session_id) continue;
      entries.set(p.session_id, {
        key: p.session_id,
        displayName: p.session_id,  // overridden below by session name
        updatedAt: p.updated_date ? new Date(p.updated_date).getTime() : 0,
        processId: p.id,
        sessionId: p.session_id,
      });
    }

    // Merge sessions: update names and add sessions without a stopped process
    for (const s of rawSessions) {
      const sessionName: string | null | undefined = s.name;
      const updatedAt: number = s.updated_date ? new Date(s.updated_date).getTime() : 0;
      const existing = entries.get(s.id);
      if (existing) {
        if (sessionName) existing.displayName = sessionName;
        if (updatedAt > existing.updatedAt) existing.updatedAt = updatedAt;
      } else {
        entries.set(s.id, {
          key: s.id,
          displayName: sessionName || s.id,
          updatedAt,
          sessionId: s.id,
        });
      }
    }

    return Array.from(entries.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10);
  }, [closedProcesses, rawSessions]);
}

interface HistoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (entry: HistoryEntry) => void;
}

export function HistoryModal({ open, onOpenChange, onSelect }: HistoryModalProps) {
  const entries = useHistoryEntries();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-4">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold">Recent Sessions</DialogTitle>
        </DialogHeader>
        {entries.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">No recent sessions</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {entries.map((entry) => (
              <li key={entry.key}>
                <button
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => onSelect(entry)}
                >
                  <ClaudeIcon className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                  <span className="min-w-0 flex-1 truncate font-medium">{entry.displayName}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(entry.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

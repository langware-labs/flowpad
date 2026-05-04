import { AgenticProcess, QueryFilter, QueryRequest } from '@sdk';
import type { IDockPointer, ClaudeSessionRecordData } from '@sdk';
import { useEntitiesQuery } from '@sdk/react/hooks';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { useClaudeHistory } from '@src/hooks/useClaudeHistory';
import { useContext } from '@src/hooks/useContext';
import React, { useEffect, useMemo, useState } from 'react';

const LIMIT = 10;
const HISTORY_FETCH = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function basename(path: string | null | undefined): string {
  if (!path) return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function shortId(id: string): string {
  return id.slice(0, 6);
}

/** Pick the best human-readable label from the available session/history fields. */
function pickLabel(opts: {
  sessionName?: string | null;
  slug?: string | null;
  display?: string | null;
  lastUserMessage?: string | null;
  cwd?: string | null;
  sessionId: string;
}): string {
  const candidates = [opts.sessionName, opts.slug, opts.display, opts.lastUserMessage];
  for (const c of candidates) {
    const v = (c ?? '').trim();
    if (v && !UUID_RE.test(v) && v !== opts.sessionId) {
      return v.length > 80 ? `${v.slice(0, 80)}…` : v;
    }
  }
  const proj = basename(opts.cwd);
  return proj ? `${proj} · ${shortId(opts.sessionId)}` : shortId(opts.sessionId);
}

function buildSubline(opts: {
  cwd?: string | null;
  branch?: string | null;
  messageCount?: number | null;
}): string {
  const parts: string[] = [];
  const proj = basename(opts.cwd);
  if (proj) parts.push(proj);
  if (opts.branch) parts.push(opts.branch);
  if (opts.messageCount && opts.messageCount > 0) parts.push(`${opts.messageCount} msgs`);
  return parts.join(' · ');
}

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
  subline: string;
  time: Date;
  dockPointer: IDockPointer;
}

interface SessionMeta {
  sessionName?: string | null;
  slug?: string | null;
  display?: string | null;
  lastUserMessage?: string | null;
  cwd?: string | null;
  branch?: string | null;
  messageCount?: number | null;
}

function metaFromSession(s: ClaudeSessionRecordData | undefined): SessionMeta {
  if (!s) return {};
  return {
    sessionName: s.name,
    slug: s.slug,
    lastUserMessage: s.last_user_message,
    cwd: s.cwd,
    branch: s.git_branch,
    messageCount: s.message_count,
  };
}

const processQuery = new QueryRequest({
  type: 'agentic_process',
  scope: [],
  name: 'recentAgenticProcesses',
  query: new QueryFilter({
    order_by: { updated_date: 'desc' },
  }),
});

function stripTrailingSlash(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

export function useRecentSessions(enabled: boolean = true): RecentItem[] {
  const { project } = useContext();
  const currentProjectId = project?.id ?? null;
  const currentProjectPath = useMemo(
    () => (project?.fs_storage_mount_path ? stripTrailingSlash(project.fs_storage_mount_path) : null),
    [project?.fs_storage_mount_path],
  );

  // List 1: last N agentic_process entities. Query stays global; we filter
  // client-side by project_id so the cache/subscription is shared with anyone
  // else who needs the global list.
  const { data: processes = [] } = useEntitiesQuery<AgenticProcess>(processQuery);

  // List 2: last N entries from ~/.claude/history.jsonl across all projects
  // Only fetch history when the modal is open — otherwise each entry costs
  // a GET discovery/claude_session + POST upsertSessionProcess.
  const { entries: historyEntries } = useClaudeHistory(HISTORY_FETCH, { enabled });

  // Filter history entries by current project BEFORE the resolution loop —
  // each unfiltered entry would trigger an AgenticProcess.fromClaudeSession
  // round-trip. history.jsonl's `project` field is an absolute filesystem
  // path, so compare against fs_storage_mount_path.
  const filteredHistoryEntries = useMemo(() => {
    if (!currentProjectPath) return historyEntries;
    return historyEntries.filter((entry) => stripTrailingSlash(entry.project ?? '') === currentProjectPath);
  }, [historyEntries, currentProjectPath]);

  const [historyItems, setHistoryItems] = useState<RecentItem[]>([]);

  // Per-session metadata harvested from history entries (ships `_session` with `include=claude_session`).
  const sessionMetaMap = useMemo(() => {
    const m = new Map<string, SessionMeta>();
    for (const entry of filteredHistoryEntries) {
      if (!entry.session_id) continue;
      const fromSession = metaFromSession(entry._session);
      m.set(entry.session_id, {
        ...fromSession,
        display: entry.display || entry.name || fromSession.display,
      });
    }
    return m;
  }, [filteredHistoryEntries]);

  useEffect(() => {
    if (!enabled || filteredHistoryEntries.length === 0) {
      setHistoryItems([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const resolved: RecentItem[] = [];
      for (const entry of filteredHistoryEntries) {
        if (!entry.session_id) continue;
        try {
          const p = await AgenticProcess.fromClaudeSession(entry.session_id);
          if (!cancelled && p) {
            const meta = sessionMetaMap.get(entry.session_id) ?? {};
            resolved.push({
              id: entry.session_id,
              name: pickLabel({ ...meta, sessionId: entry.session_id }),
              subline: buildSubline(meta),
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
  }, [enabled, filteredHistoryEntries, sessionMetaMap]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => {
    const processItems: RecentItem[] = processes
      .filter((p) => p.session_id != null)
      .filter((p) => currentProjectId == null || p.project_id === currentProjectId)
      .map((p) => {
        const sid = p.session_id!;
        const meta = sessionMetaMap.get(sid) ?? {};
        const sessionName = (p.name && p.name !== sid ? p.name : null) ?? meta.sessionName ?? null;
        return {
          id: sid,
          name: pickLabel({ ...meta, sessionName, sessionId: sid }),
          subline: buildSubline(meta),
          time: new Date(p.updated_date ?? 0),
          dockPointer: p.dockPointer,
        };
      });

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
  }, [processes, historyItems, sessionMetaMap, currentProjectId]);
}

interface HistoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (item: RecentItem) => void;
}

export function HistoryModal({ open, onOpenChange, onSelect }: HistoryModalProps) {
  const items = useRecentSessions(open);

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
                  <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                    <span className="truncate font-medium">{item.name}</span>
                    {item.subline ? (
                      <span className="truncate text-xs text-muted-foreground">{item.subline}</span>
                    ) : null}
                  </span>
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

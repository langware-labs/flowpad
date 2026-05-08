import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Search } from 'lucide-react';
import React from 'react';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shortId(id: string): string {
  return id.slice(0, 6);
}

function pickLabelFallback(entry: WorkerHistoryEntry): string {
  const name = (entry.name ?? '').trim();
  if (name && !UUID_RE.test(name) && name !== entry.worker_id) {
    return name.length > 80 ? `${name.slice(0, 80)}…` : name;
  }
  return entry.project_name
    ? `${entry.project_name} · ${shortId(entry.worker_id)}`
    : shortId(entry.worker_id);
}

function buildSubline(entry: WorkerHistoryEntry): string {
  const parts: string[] = [];
  if (entry.project_name) parts.push(entry.project_name);
  if (entry.git_branch) parts.push(entry.git_branch);
  if (entry.message_count && entry.message_count > 0) parts.push(`${entry.message_count} msgs`);
  return parts.join(' · ');
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function WorkerIcon({ workerType }: { workerType: WorkerHistoryEntry['worker_type'] }) {
  if (workerType === 'codex') {
    return <CodexIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />;
  }
  return <ClaudeIcon className="h-3.5 w-3.5 shrink-0 text-orange-500" />;
}

interface HistoryModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (entry: WorkerHistoryEntry) => void;
}

export function HistoryModal({ open, onOpenChange, onSelect }: HistoryModalProps) {
  const { entries, isLoading } = useWorkerHistory(30, { enabled: open });
  const { navigation } = useDockNavigation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-full max-w-sm flex-col overflow-hidden p-4 max-h-[80vh]">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2 pr-7">
            <DialogTitle className="text-sm font-semibold">Recent Sessions</DialogTitle>
            <button
              type="button"
              title="Search all sessions"
              className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => {
                onOpenChange(false);
                navigation.openSearch();
              }}
            >
              <Search className="h-3.5 w-3.5" />
            </button>
          </div>
        </DialogHeader>
        {isLoading && entries.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="py-4 text-center text-xs text-muted-foreground">No recent sessions</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5 overflow-y-auto">
            {entries.map((entry) => {
              const subline = buildSubline(entry);
              return (
                <li key={`${entry.worker_type}:${entry.worker_id}`} className="min-w-0">
                  <button
                    className="flex w-full min-w-0 items-center gap-2 overflow-hidden rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => onSelect(entry)}
                  >
                    <WorkerIcon workerType={entry.worker_type} />
                    <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                      <span className="truncate font-medium">{pickLabelFallback(entry)}</span>
                      {subline ? (
                        <span className="truncate text-xs text-muted-foreground">{subline}</span>
                      ) : null}
                    </span>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      {timeAgo(entry.last_active_time)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

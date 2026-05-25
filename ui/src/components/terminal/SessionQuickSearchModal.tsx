import { AgenticProcess } from '@sdk';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@src/components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@src/components/ui/dialog';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { toast } from '@src/hooks/use-toast';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

const HISTORY_LIMIT = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SessionQuickSearchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

function entryKey(e: WorkerHistoryEntry): string {
  return `${e.worker_type}:${e.worker_id}`;
}

function displayName(e: WorkerHistoryEntry): string {
  const name = (e.name ?? '').trim();
  if (name && !UUID_RE.test(name) && name !== e.worker_id) return name;
  const prompt = (e.last_prompt ?? '').trim();
  if (prompt) return prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  return 'Untitled session';
}

export function SessionQuickSearchModal({ open, onOpenChange }: SessionQuickSearchModalProps) {
  const { navigation } = useDockNavigation();
  const { entries, isLoading } = useWorkerHistory(HISTORY_LIMIT, { enabled: open });
  const [query, setQuery] = useState('');
  const [opening, setOpening] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? entries.filter((e) => {
          const hay = [e.name, e.last_prompt, e.project_name]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return hay.includes(q);
        })
      : entries;
    return [...filtered].sort((a, b) => {
      const ta = a.last_active_time ? Date.parse(a.last_active_time) : 0;
      const tb = b.last_active_time ? Date.parse(b.last_active_time) : 0;
      return tb - ta;
    });
  }, [entries, query]);

  const handleSelect = async (entry: WorkerHistoryEntry) => {
    const key = entryKey(entry);
    setOpening(key);
    try {
      let process: AgenticProcess | null = null;
      if (entry.agentic_process_id) {
        try {
          process = (await AgenticProcess.getById(entry.agentic_process_id)) ?? null;
        } catch {
          process = null;
        }
      }
      if (!process) {
        try {
          process = await AgenticProcess.getByWorkerId(entry.worker_id);
        } catch {
          process = null;
        }
      }
      if (!process) {
        toast({
          title: 'Session not found',
          description: `Session ${entry.worker_id} is not in Claude or Codex history.`,
          variant: 'destructive',
        });
        return;
      }
      navigation.openDock(process.terminalDockPointer);
      onOpenChange(false);
    } finally {
      setOpening(null);
    }
  };

  useEffect(() => {
    if (!open) {
      setQuery('');
      setOpening(null);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-[640px]">
        <DialogTitle className="sr-only">Search sessions</DialogTitle>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search sessions..."
            data-testid="session-quick-search-input"
          />
          <CommandList className="max-h-[420px]">
            {isLoading && visible.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : visible.length === 0 ? (
              <CommandEmpty>{query.trim() ? 'No matching sessions.' : 'No recent sessions.'}</CommandEmpty>
            ) : (
              visible.map((e) => {
                const key = entryKey(e);
                const Icon = e.worker_type === 'codex' ? CodexIcon : ClaudeIcon;
                const iconClass = e.worker_type === 'codex' ? 'text-emerald-500' : 'text-orange-500';
                return (
                  <CommandItem
                    key={key}
                    value={`${key} ${e.name ?? ''} ${e.last_prompt ?? ''} ${e.project_name ?? ''}`}
                    onSelect={() => void handleSelect(e)}
                    data-testid="session-quick-search-result"
                  >
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
                    <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                      <span className="truncate text-sm">{displayName(e)}</span>
                      {e.project_name && (
                        <span className="truncate text-[10px] text-muted-foreground/70">{e.project_name}</span>
                      )}
                    </span>
                    {opening === key ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(e.last_active_time)}</span>
                    )}
                  </CommandItem>
                );
              })
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

import { AgenticProcess } from '@sdk';
import apiClient from '@sdk/client';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@src/components/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@src/components/ui/dialog';
import type { SearchResult } from '@src/hooks/use-record-search';
import { toast } from '@src/hooks/use-toast';
import { useWorkerHistory, type WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

const HISTORY_LIMIT = 50;
const SEARCH_LIMIT_PER_TYPE = 25;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_PATH = '/graph/compute_node/@local/fs-records/search';
const SESSION_TYPES = ['claude_session', 'codex_session'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SessionRow {
  key: string;
  workerType: 'claude' | 'codex';
  workerId: string;
  agenticProcessId: string | null;
  title: string;
  subtitle: string;
  timestamp: string | null;
}

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

function historyDisplayName(e: WorkerHistoryEntry): string {
  const name = (e.name ?? '').trim();
  if (name && !UUID_RE.test(name) && name !== e.worker_id) return name;
  const prompt = (e.last_prompt ?? '').trim();
  if (prompt) return prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  return 'Untitled session';
}

function historyToRow(e: WorkerHistoryEntry): SessionRow {
  return {
    key: `${e.worker_type}:${e.worker_id}`,
    workerType: e.worker_type,
    workerId: e.worker_id,
    agenticProcessId: e.agentic_process_id,
    title: historyDisplayName(e),
    subtitle: e.project_name ?? '',
    timestamp: e.last_active_time,
  };
}

// Reverse the encoding the indexer uses for claude projects, e.g.
// "-Users-shlom-Documents-dev-flowpad-oss" → "flowpad-oss".
function projectNameFromAssetRef(assetRef: string): string {
  const parts = assetRef.split('/');
  parts.pop(); // filename
  const encoded = parts.pop() ?? '';
  if (!encoded) return '';
  const last = encoded.split('-').filter(Boolean).pop() ?? '';
  return last;
}

function workerIdFromSearchResult(r: SearchResult): string {
  const stem = (r.asset_ref?.split('/').pop() ?? '').replace(/\.jsonl$/i, '');
  if (r.record_type === 'codex_session' && stem.startsWith('rollout-')) {
    const segs = stem.slice('rollout-'.length).split('-');
    if (segs.length >= 5) return segs.slice(-5).join('-');
  }
  if (stem) return stem;
  return r.record_id.replace(/^(claude_session|codex_session)-/, '');
}

function searchResultDisplayName(r: SearchResult): string {
  const title = (r.fts_title ?? '').trim();
  if (title && !UUID_RE.test(title)) return title;
  const name = (r.name ?? '').trim();
  if (name && !UUID_RE.test(name)) return name;
  const desc = (r.fts_description ?? '').trim();
  if (desc) return desc.length > 80 ? `${desc.slice(0, 80)}…` : desc;
  return 'Untitled session';
}

function searchResultToRow(r: SearchResult): SessionRow {
  const workerType: 'claude' | 'codex' = r.record_type === 'codex_session' ? 'codex' : 'claude';
  return {
    key: r.record_id,
    workerType,
    workerId: workerIdFromSearchResult(r),
    agenticProcessId: null,
    title: searchResultDisplayName(r),
    subtitle: projectNameFromAssetRef(r.asset_ref ?? ''),
    timestamp: r.modified_at || null,
  };
}

export function SessionQuickSearchModal({ open, onOpenChange }: SessionQuickSearchModalProps) {
  const { navigation } = useDockNavigation();
  const { entries, isLoading: isHistoryLoading } = useWorkerHistory(HISTORY_LIMIT, { enabled: open });
  const [query, setQuery] = useState('');
  const [searchRows, setSearchRows] = useState<SessionRow[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setOpening(null);
      setSearchRows([]);
      setIsSearching(false);
    }
  }, [open]);

  const trimmed = query.trim();
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!trimmed) {
      setSearchRows([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    const controller = new AbortController();
    const myReqId = ++reqIdRef.current;
    debounceRef.current = setTimeout(() => {
      const promises = SESSION_TYPES.map((rt) => {
        const params = new URLSearchParams({
          q: trimmed,
          limit: String(SEARCH_LIMIT_PER_TYPE),
          record_type: rt,
        });
        return apiClient
          .get<{ results?: SearchResult[] }>(`${SEARCH_PATH}?${params.toString()}`, { signal: controller.signal })
          .then((d) => d?.results ?? [])
          .catch(() => [] as SearchResult[]);
      });
      Promise.all(promises).then((groups) => {
        if (myReqId !== reqIdRef.current || controller.signal.aborted) return;
        const rows = groups
          .flat()
          .map(searchResultToRow)
          .sort((a, b) => {
            const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
            const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
            return tb - ta;
          });
        setSearchRows(rows);
        setIsSearching(false);
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      controller.abort();
    };
  }, [trimmed, open]);

  const historyRows = useMemo<SessionRow[]>(() => {
    return [...entries]
      .sort((a, b) => {
        const ta = a.last_active_time ? Date.parse(a.last_active_time) : 0;
        const tb = b.last_active_time ? Date.parse(b.last_active_time) : 0;
        return tb - ta;
      })
      .map(historyToRow);
  }, [entries]);

  const visible = trimmed ? searchRows : historyRows;
  const isLoading = trimmed ? isSearching : isHistoryLoading;

  const handleSelect = async (row: SessionRow) => {
    setOpening(row.key);
    try {
      let process: AgenticProcess | null = null;
      if (row.agenticProcessId) {
        try {
          process = (await AgenticProcess.getById(row.agenticProcessId)) ?? null;
        } catch {
          process = null;
        }
      }
      if (!process) {
        try {
          process = await AgenticProcess.getByWorkerId(row.workerId);
        } catch {
          process = null;
        }
      }
      if (!process) {
        toast({
          title: 'Session not found',
          description: `Session ${row.workerId} is not in Claude or Codex history.`,
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
                <Loader2 className="h-4 w-4 animate-spin" />
                {trimmed ? 'Searching…' : 'Loading history'}
              </div>
            ) : visible.length === 0 ? (
              <CommandEmpty>{trimmed ? 'No matching sessions.' : 'No recent sessions.'}</CommandEmpty>
            ) : (
              visible.map((row) => {
                const Icon = row.workerType === 'codex' ? CodexIcon : ClaudeIcon;
                const iconClass = row.workerType === 'codex' ? 'text-emerald-500' : 'text-orange-500';
                return (
                  <CommandItem
                    key={row.key}
                    value={`${row.key} ${row.title} ${row.subtitle}`}
                    onSelect={() => void handleSelect(row)}
                    data-testid="session-quick-search-result"
                  >
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${iconClass}`} />
                    <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                      <span className="truncate text-sm">{row.title}</span>
                      {row.subtitle && (
                        <span className="truncate text-[10px] text-muted-foreground/70">{row.subtitle}</span>
                      )}
                    </span>
                    {opening === row.key ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(row.timestamp)}</span>
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

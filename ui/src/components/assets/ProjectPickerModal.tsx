import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { useProjectList, getProjectDisplayName } from '@src/hooks/use-claude-projects';
import type { ProjectListItem } from '@sdk';

interface ProjectPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  onConfirm: (ids: string[]) => void;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

interface RowItem {
  pid: string;
  raw: ProjectListItem;
  label: string;
  cwd: string;
  modifiedMs: number;
}

export function ProjectPickerModal({
  open,
  onOpenChange,
  selectedIds,
  onConfirm,
}: ProjectPickerModalProps): React.ReactElement {
  const { projects, isLoading } = useProjectList({ enabled: open });
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set(selectedIds));
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    setCheckedIds(new Set(selectedIds));
    setSearch('');
  }, [open, selectedIds]);

  const rows = useMemo<RowItem[]>(() => {
    const out: RowItem[] = [];
    for (const p of projects) {
      const pid = p.id;
      if (!pid) continue;
      out.push({
        pid,
        raw: p,
        label: getProjectDisplayName(p),
        cwd: p.cwd || '',
        modifiedMs: p.modified_at ? new Date(p.modified_at).getTime() : 0,
      });
    }
    out.sort((a, b) => b.modifiedMs - a.modifiedMs);
    return out;
  }, [projects]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.label.toLowerCase().includes(q) || r.cwd.toLowerCase().includes(q),
    );
  }, [rows, search]);

  const toggle = (pid: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      for (const r of filtered) next.add(r.pid);
      return next;
    });
  };

  const clearSelection = () => setCheckedIds(new Set());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Select Projects</DialogTitle>
          <DialogDescription>Choose which projects to filter by. Sorted by latest activity.</DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search projects…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 text-sm"
            autoFocus
          />
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {checkedIds.size} selected
            {search.trim() ? ` · ${filtered.length} match${filtered.length === 1 ? '' : 'es'}` : ''}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={selectAllFiltered}
              disabled={filtered.length === 0}
              className="rounded-md px-2 py-1 hover:bg-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {search.trim() ? 'Select all matches' : 'Select all'}
            </button>
            <button
              type="button"
              onClick={clearSelection}
              disabled={checkedIds.size === 0}
              className="rounded-md px-2 py-1 hover:bg-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear selection
            </button>
          </div>
        </div>

        <div className="max-h-96 overflow-y-auto rounded-lg border border-border bg-card">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading projects...
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {rows.length === 0 ? 'No projects found' : 'No matches'}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((r) => {
                const checked = checkedIds.has(r.pid);
                return (
                  <label
                    key={r.pid}
                    className={`flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent/50 ${
                      checked ? 'bg-accent/30' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(r.pid)}
                      className="h-4 w-4 shrink-0 rounded border-input"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{r.label}</div>
                      {r.cwd && (
                        <div className="truncate font-mono text-xs text-muted-foreground">{r.cwd}</div>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-0.5">
                      {r.raw.session_count > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {r.raw.session_count} session{r.raw.session_count !== 1 ? 's' : ''}
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground/70">
                        {relativeTime(r.raw.modified_at)}
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="h-8 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(Array.from(checkedIds))}
            className="h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/90"
          >
            Confirm
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
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
import { projectRecencyMs } from '@src/lib/project-recency';
import type { ProjectListItem } from '@sdk';

interface ProjectPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  /** Selected ids plus their full list items (for consumers that need cwd etc.). */
  onConfirm: (ids: string[], items: ProjectListItem[]) => void;
  /** Optional description override — the default keeps the scope-filter wording. */
  description?: React.ReactNode;
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

function renderRow(r: RowItem, checked: boolean, toggle: (pid: string) => void): React.ReactElement {
  return (
    <label
      key={r.pid}
      className={`flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-start text-sm transition-colors hover:bg-accent/50 ${
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
        {r.cwd && <div className="truncate font-mono text-xs text-muted-foreground">{r.cwd}</div>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {r.raw.session_count > 0 && (
          <span className="text-xs text-muted-foreground">
            {r.raw.session_count} session{r.raw.session_count !== 1 ? 's' : ''}
          </span>
        )}
        <span className="text-xs text-muted-foreground/70">{relativeTime(r.raw.modified_at)}</span>
      </div>
    </label>
  );
}

export function ProjectPickerModal({
  open,
  onOpenChange,
  selectedIds,
  onConfirm,
  description,
}: ProjectPickerModalProps): React.ReactElement {
  const { t } = useLingui();
  const { projects, isLoading } = useProjectList({ enabled: open });
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set(selectedIds));
  const [search, setSearch] = useState('');
  // Snapshot of the selection taken when the modal opens. Drives the
  // selected-first ordering so rows stay put as the user toggles checkboxes
  // (live `checkedIds` would make rows jump between the two groups mid-click).
  const [initialSelected, setInitialSelected] = useState<Set<string>>(new Set(selectedIds));

  useEffect(() => {
    if (!open) return;
    setCheckedIds(new Set(selectedIds));
    setInitialSelected(new Set(selectedIds));
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
        // `last_active_at` (UI-open recency) wins; session `modified_at` falls back.
        modifiedMs: projectRecencyMs(p) ?? 0,
      });
    }
    out.sort((a, b) => b.modifiedMs - a.modifiedMs);
    return out;
  }, [projects]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.label.toLowerCase().includes(q) || r.cwd.toLowerCase().includes(q));
  }, [rows, search]);

  // Selected projects (as of when the modal opened) float to the top, followed
  // by a separator and the rest. Order within each group keeps the latest-activity sort.
  const { selectedRows, otherRows } = useMemo(() => {
    const sel: RowItem[] = [];
    const other: RowItem[] = [];
    for (const r of filtered) {
      if (initialSelected.has(r.pid)) sel.push(r);
      else other.push(r);
    }
    return { selectedRows: sel, otherRows: other };
  }, [filtered, initialSelected]);

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
          <DialogTitle>
            <Trans>Select Projects</Trans>
          </DialogTitle>
          <DialogDescription>
            {description ?? <Trans>Choose which projects to filter by. Sorted by latest activity.</Trans>}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t`Search projects…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 ps-8 text-sm"
            autoFocus
          />
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            <Trans>{checkedIds.size} selected</Trans>
            {search.trim() ? ` · ${filtered.length} match${filtered.length === 1 ? '' : 'es'}` : ''}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={selectAllFiltered}
              disabled={filtered.length === 0}
              className="rounded-md px-2 py-1 hover:bg-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {search.trim() ? t`Select all matches` : t`Select all`}
            </button>
            <button
              type="button"
              onClick={clearSelection}
              disabled={checkedIds.size === 0}
              className="rounded-md px-2 py-1 hover:bg-accent/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trans>Clear selection</Trans>
            </button>
          </div>
        </div>

        <div className="max-h-96 overflow-y-auto rounded-lg border border-border bg-card">
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
              <Trans>Loading projects...</Trans>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {rows.length === 0 ? t`No projects found` : t`No matches`}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {selectedRows.map((r) => renderRow(r, checkedIds.has(r.pid), toggle))}
              {selectedRows.length > 0 && otherRows.length > 0 && (
                <div className="bg-muted/40 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Trans>Other projects</Trans>
                </div>
              )}
              {otherRows.map((r) => renderRow(r, checkedIds.has(r.pid), toggle))}
            </div>
          )}
        </div>

        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="h-8 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground hover:text-foreground"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            onClick={() =>
              onConfirm(
                Array.from(checkedIds),
                rows.filter((r) => checkedIds.has(r.pid)).map((r) => r.raw),
              )
            }
            className="h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/90"
          >
            <Trans>Confirm</Trans>
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

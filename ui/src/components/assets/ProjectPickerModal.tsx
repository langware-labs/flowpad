import React, { useEffect, useMemo, useState } from 'react';
import apiClient from '@sdk/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@src/components/ui/dialog';

interface ProjectPickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: string[];
  onConfirm: (ids: string[]) => void;
}

interface ProjectResult {
  record_id: string;
  name: string;
}

export function ProjectPickerModal({
  open,
  onOpenChange,
  selectedIds,
  onConfirm,
}: ProjectPickerModalProps): React.ReactElement {
  const [projects, setProjects] = useState<ProjectResult[]>([]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set(selectedIds));
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    setCheckedIds(new Set(selectedIds));
    setSearch('');
    setLoading(true);
    apiClient
      .get('/search?record_type=project&limit=200')
      .then((data: unknown) => {
        const d = data as { results?: ProjectResult[] } | null;
        setProjects(d?.results ?? []);
      })
      .catch(() => {
        setProjects([]);
      })
      .finally(() => setLoading(false));
  }, [open, selectedIds]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, search]);

  const toggleProject = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Select Projects</DialogTitle>
          <DialogDescription>Choose which projects to filter by.</DialogDescription>
        </DialogHeader>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search projects…"
          className="h-8 w-full rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          autoFocus
        />

        <div className="max-h-96 overflow-y-auto rounded-md border border-input">
          {loading ? (
            <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
              {search ? 'No matches' : 'No projects found'}
            </div>
          ) : (
            <div className="flex flex-col gap-0.5 p-1">
              {filtered.map((p) => (
                <label
                  key={p.record_id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={checkedIds.has(p.record_id)}
                    onChange={() => toggleProject(p.record_id)}
                    className="h-4 w-4 rounded border-input"
                  />
                  <span className="truncate" title={p.name}>{p.name}</span>
                </label>
              ))}
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

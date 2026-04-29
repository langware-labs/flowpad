import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, Search } from 'lucide-react';
import { dataManager, Project, QueryRequest, Task, TypeId } from '@sdk';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Button } from '@src/components/ui/button';
import { useProjectMapping } from './useProjectMapping';

interface ProjectMappingDialogProps {
  open: boolean;
  onClose: () => void;
  remoteProjectId: string;
  remoteProjectName: string;
  taskId: string;
  onMapped: (localProjectId: string, projectRoot: string | undefined) => void;
}

export function ProjectMappingDialog({
  open,
  onClose,
  remoteProjectId,
  remoteProjectName,
  taskId,
  onMapped,
}: ProjectMappingDialogProps) {
  const { setMapping } = useProjectMapping();
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSelectedId(null);
    setFilter('');
    void (async () => {
      try {
        const all = await dataManager.query(new QueryRequest({ type: Project.type }));
        setProjects((all as Project[]).filter((p) => !!p.fs_storage_mount_path));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load projects');
      }
    })();
  }, [open]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      (p.name ?? '').toLowerCase().includes(q) || (p.fs_storage_mount_path ?? '').toLowerCase().includes(q),
    );
  }, [projects, filter]);

  const handleConfirm = async () => {
    const proj = projects.find((p) => p.id === selectedId);
    if (!proj || !proj.id) return;
    setBusy(true);
    setError(null);
    try {
      // Only persist a remote→local mapping when we actually have a remote
      // project_id to key it under. For tasks that arrived without one, we
      // still want to set project_root on the task itself.
      if (remoteProjectId) {
        await setMapping(remoteProjectId, proj.id);
      }
      const task = await dataManager.getByTypeId<Task>(new TypeId(Task.type, taskId)).catch(() => null);
      if (task) {
        task.metadata = {
          ...(task.metadata ?? {}),
          project_id: proj.id,
          project_name: proj.name ?? '',
          project_root: proj.fs_storage_mount_path ?? '',
        };
        await task.save();
      }
      onMapped(proj.id, proj.fs_storage_mount_path);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set mapping');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{remoteProjectId ? 'Map remote project' : 'Pick a project'}</DialogTitle>
          <DialogDescription>
            {remoteProjectId ? (
              <>
                This task came from a project on another machine
                {remoteProjectName ? <> called <span className="font-medium text-foreground">{remoteProjectName}</span></> : null}.
                Pick a local project folder to map it to. The mapping is remembered for future messages.
              </>
            ) : (
              <>Pick the local project folder this conversation should run in. We'll use it as the working directory for Claude Code sessions on this task.</>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Filter projects…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 w-full rounded border border-input bg-background pl-7 pr-2 text-xs focus:border-primary focus:outline-none"
            />
          </div>

          <div className="max-h-72 overflow-auto rounded-md border border-border">
            {filtered.length === 0 ? (
              <div className="py-6 text-center text-xs text-muted-foreground">
                No projects found.
              </div>
            ) : (
              filtered.map((p) => {
                const isSel = selectedId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedId(p.id ?? null)}
                    className={`flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left transition-colors last:border-b-0 ${
                      isSel ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
                    }`}
                  >
                    <FolderOpen className="h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{p.name ?? '(unnamed)'}</div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {p.fs_storage_mount_path ?? ''}
                        {p.id ? <span className="ml-2 opacity-60">· {p.id}</span> : null}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void handleConfirm()} disabled={!selectedId || busy}>
            {busy ? 'Saving…' : 'Use this project'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

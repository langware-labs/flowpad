import { dataContext, Task, TypeId, VFSPath } from '@sdk';
import { hasBrowseableDrag, hasExternalFilesDrag, readBrowseableDrag } from '@src/components/browseable-tree/drag';
import { isFsDragItem } from '@src/components/browseable-tree/adapters/fsFolderRoot';
import { openArtifact } from '@src/components/task-bar/task-utils';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useTaskGitAttachmentFolders } from '@src/hooks/use-task-git-attachments';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { File as FileIcon, Folder as FolderIcon, GitBranch, Plus, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

interface Attachment {
  path: string;
  label: string;
}

interface TaskAttachmentsProps {
  task: Task;
  save: (patch: Partial<Task>) => Promise<void>;
}

/** task.artifacts entries are `string | {path, label}` — normalize for display. */
function normalizeAttachments(artifacts: unknown): Attachment[] {
  if (!Array.isArray(artifacts)) return [];
  const out: Attachment[] = [];
  for (const a of artifacts) {
    if (typeof a === 'string' && a) {
      out.push({ path: a, label: a.split('/').pop() || a });
    } else if (a && typeof a === 'object' && typeof a.path === 'string') {
      out.push({ path: a.path, label: a.label || a.path.split('/').pop() });
    }
  }
  return out;
}

/** Machine path of an in-app tree drag (`fs-file:<typeid>:<rel>` rows). */
function machinePathFromDrag(typeIdStr: string, relPath: string): string | null {
  try {
    return VFSPath.fromTypeId(new TypeId(typeIdStr), relPath).machinePath || null;
  } catch {
    return null;
  }
}

/**
 * The task's Attachments section (replaces the old Plan/spec.md block): the
 * files and folders this task is about. Add via drag & drop — in-app tree rows
 * or OS files (desktop app) — or the + button (native file/folder picker).
 * Stored in the existing `artifacts` field (`{path, label}`), so the TaskCard
 * artifacts row renders the same list. Folders inside a git context folder get
 * a git sub-icon.
 */
export function TaskAttachments({ task, save }: TaskAttachmentsProps) {
  const { navigation } = useDockNavigation();
  const [dragOver, setDragOver] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  const attachments = useMemo(() => normalizeAttachments(task.artifacts), [task.artifacts]);

  // Git detection: an attachment that IS (or lives inside) one of the task's
  // project git context folders gets the git sub-icon. Reuse the exact
  // classification the send path uses (`useTaskGitAttachmentFolders`) so the
  // badge shows on precisely the folders that ride as git chips — its project
  // fallback (`dataContext.project`) resolves for project-less TaskBar tasks,
  // where this panel's own URL scope alone would leave ZERO git dirs.
  const { isGitPath } = useTaskGitAttachmentFolders(task);

  // Received tasks carry folder-relative attachment entries
  // (`attachments/<name>` — packed into the task folder by the sender's
  // bundle); resolve them against the task folder for open/git checks.
  const absolutePath = useCallback(
    (path: string) => (path.startsWith('/') ? path : `${(task.asset_ref || '').replace(/\/$/, '')}/${path}`),
    [task.asset_ref],
  );

  const persist = useCallback(
    (next: Attachment[]) => void save({ artifacts: next as unknown as Task['artifacts'] }),
    [save],
  );

  const addPaths = useCallback(
    (paths: string[]) => {
      const existing = new Set(attachments.map((a) => a.path));
      const added = paths
        .filter((p) => p && !existing.has(p))
        .map((p) => ({ path: p, label: p.split('/').pop() || p }));
      if (added.length) persist([...attachments, ...added]);
    },
    [attachments, persist],
  );

  const removePath = useCallback(
    (path: string) => persist(attachments.filter((a) => a.path !== path)),
    [attachments, persist],
  );

  const pickAndAdd = useCallback(
    async (mode: 'file' | 'folder') => {
      setAddOpen(false);
      const computeNode = dataContext.computeNode;
      if (!computeNode) return;
      const picked = await computeNode.openPathDialog(undefined, mode);
      if (picked) addPaths([picked]);
    },
    [addPaths],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);

      // In-app tree rows (Assets navigator, file manager) carry the
      // browseable drag payload with a VFS-relative path.
      const dragData = readBrowseableDrag(e);
      if (dragData && isFsDragItem(dragData)) {
        const parts = dragData.id.split(':');
        const typeIdStr = parts.length >= 3 ? parts[1] : null;
        const entries = dragData.items?.length ? dragData.items.map((it) => it.relPath) : [dragData.relPath];
        const paths = typeIdStr
          ? entries.map((rel) => machinePathFromDrag(typeIdStr, rel)).filter((p): p is string => !!p)
          : [];
        if (paths.length) addPaths(paths);
        return;
      }

      // OS drops: the desktop app exposes absolute paths on File objects; the
      // plain browser doesn't, so point the user at the + button there.
      const files = Array.from(e.dataTransfer.files ?? []);
      const withPaths = files.map((f) => (f as any).path as string | undefined).filter((p): p is string => !!p);
      if (withPaths.length) {
        addPaths(withPaths);
      } else if (files.length) {
        notify.warning({
          title: 'Could not read the dropped path',
          message: 'Dropping from Finder needs the desktop app — use the + button instead.',
        });
      }
    },
    [addPaths],
  );

  const droppable = (e: React.DragEvent) => hasBrowseableDrag(e) || hasExternalFilesDrag(e);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-6 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Attachments</span>
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Add attachment"
              data-testid="task-attachments-add"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-44 p-1" align="end">
            <button
              type="button"
              onClick={() => void pickAndAdd('file')}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
            >
              <FileIcon className="h-4 w-4 text-muted-foreground" /> File…
            </button>
            <button
              type="button"
              onClick={() => void pickAndAdd('folder')}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
            >
              <FolderIcon className="h-4 w-4 text-muted-foreground" /> Folder…
            </button>
          </PopoverContent>
        </Popover>
      </div>

      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto p-3 transition-colors',
          dragOver && 'bg-primary/5 outline-dashed outline-2 -outline-offset-4 outline-primary/40',
        )}
        onDragOver={(e) => {
          if (!droppable(e)) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        data-testid="task-attachments-drop"
      >
        {attachments.length === 0 ? (
          <div className="flex h-full min-h-24 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
            <span>No attachments yet</span>
            <span className="text-xs">Drag files or folders here, or use the + button</span>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {attachments.map((a) => {
              const isFolderish = !/\.[A-Za-z0-9]{1,8}$/.test(a.label);
              const git = isGitPath(absolutePath(a.path));
              return (
                <div
                  key={a.path}
                  className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <span className="relative shrink-0">
                    {isFolderish ? (
                      <FolderIcon className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <FileIcon className="h-4 w-4 text-muted-foreground" />
                    )}
                    {git && (
                      <GitBranch className="absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-full bg-background text-orange-500" />
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => openArtifact(absolutePath(a.path), navigation)}
                    className="min-w-0 flex-1 truncate text-left hover:underline"
                    title={a.path}
                  >
                    {a.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => removePath(a.path)}
                    className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:block"
                    title="Remove attachment"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

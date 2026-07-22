import {
  dataContext,
  Folder,
  formatGitOrigin,
  fsManager,
  gitOriginCloneUrl,
  launchWizard,
  Project,
  Task,
  TypeId,
  VFSPath,
  type GitOrigin,
} from '@sdk';
import { resolveLocalGitRoot } from '@src/utils/gitUtils';
import { type Attachment, attachmentKey, makeAttachmentEntry, normalizeAttachments } from './task-attachments-utils';
import { useEntity } from '@sdk/react/hooks';
import { hasBrowseableDrag, hasExternalFilesDrag, readBrowseableDrag } from '@src/components/browseable-tree/drag';
import { isFsDragItem } from '@src/components/browseable-tree/adapters/fsFolderRoot';
import { openArtifact } from '@src/components/task-bar/task-utils';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useProjectContextFolders } from '@src/hooks/use-project-context-folders';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { cn } from '@src/lib/utils';
import { notify } from '@src/notifications';
import { File as FileIcon, Folder as FolderIcon, GitBranch, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

interface TaskAttachmentsProps {
  task: Task;
  save: (patch: Partial<Task>) => Promise<void>;
  /** Read-only: hide the add (+) button, the drop zone's drag-to-add, and the
   *  per-row remove (X). Used to show a member task's PARENT files & folders,
   *  which the child view surfaces but cannot edit. Rows stay openable. */
  readOnly?: boolean;
  /** Override the section header (defaults to "Files & Folders"). */
  heading?: ReactNode;
}

/**
 * Local, per-machine record of which git folders this user has installed for a
 * task (keyed by task id → set of attachment KEYS — the machine-independent
 * `attachmentKey`, never the sender's path). Lives in localStorage, NOT in the
 * task's shared `artifacts` — install is a per-recipient action, so it must
 * never ride to other people who receive the task.
 */
const gitInstalledKey = (taskId: string) => `flowpad.task.gitInstalled.${taskId}`;

function readInstalledGitPaths(taskId: string): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(gitInstalledKey(taskId));
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeInstalledGitPaths(taskId: string, paths: ReadonlySet<string>): void {
  try {
    localStorage.setItem(gitInstalledKey(taskId), JSON.stringify([...paths]));
  } catch {
    // Storage unavailable / quota — the in-memory set still holds for this load.
  }
}

/** Heuristic: an attachment label with no file extension is a folder. */
const looksLikeFolder = (label: string) => !/\.[A-Za-z0-9]{1,8}$/.test(label);

/**
 * The task's Attachments section (replaces the old Plan/spec.md block): the
 * files and folders this task is about. Add via drag & drop — in-app tree rows
 * or OS files (desktop app) — or the + button (native file/folder picker).
 * Stored in the existing `artifacts` field (`{path, label, git_origin?}`), so
 * the TaskCard artifacts row renders the same list. Folders inside a git
 * context folder get a git sub-icon, and their repo origin is captured at
 * attach time (`git_origin`) so it rides in task.md to the recipient — clicking
 * a not-present git folder there launches the git-context-folder clone wizard.
 */
export function TaskAttachments({ task, save, readOnly = false, heading }: TaskAttachmentsProps) {
  const { navigation, currentDock } = useDockNavigation();
  const currentDockScope = currentDock?.scopeFilter ?? null;
  const [dragOver, setDragOver] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // Git folders this user has installed via the wizard (keyed by attachment
  // path), persisted per-machine in localStorage. Mirrors the message chip's
  // per-recipient `installed` flag: the first click always installs (wizard),
  // later clicks open the folder's content.
  const [installedGitPaths, setInstalledGitPaths] = useState<ReadonlySet<string>>(() => readInstalledGitPaths(task.id));
  // Re-hydrate when the shown task changes (the component may be reused).
  useEffect(() => setInstalledGitPaths(readInstalledGitPaths(task.id)), [task.id]);

  const attachments = useMemo(() => normalizeAttachments(task.artifacts), [task.artifacts]);

  // Git detection: an attachment that IS (or lives inside) one of the
  // project's git context folders gets the git sub-icon. User-scope tasks
  // (~/tasks) carry no project_id — fall back to the URL scope's project,
  // which is where the dragged context folders live.
  const scopeProjectId = task.project_id || currentDockScope?.activeProjectId || null;
  const { data: project } = useEntity<Project>(scopeProjectId ? new TypeId(Project.type, scopeProjectId) : null);
  const { contextDirInfos } = useProjectContextFolders(project ?? null);
  const gitDirs = useMemo(
    () =>
      contextDirInfos
        .filter((i) => i.origin_kind === 'git')
        .map((i) => ({ path: i.path.replace(/\/$/, ''), typeid: i.typeid })),
    [contextDirInfos],
  );
  const gitDirFor = useCallback(
    (path: string) => {
      const p = path.replace(/\/$/, '');
      return gitDirs.find((g) => p === g.path || p.startsWith(g.path + '/')) ?? null;
    },
    [gitDirs],
  );
  const isGitPath = useCallback((path: string) => !!gitDirFor(path), [gitDirFor]);

  // Capture the repo origin for a path that lives in a git context folder, read
  // off the folder's Folder entity (the recipient has neither, so it must ride
  // on the attachment). Null for non-git paths or origins with no clone URL.
  const resolveGitOrigin = useCallback(
    async (path: string): Promise<GitOrigin | undefined> => {
      const dir = gitDirFor(path);
      if (!dir?.typeid) return undefined;
      try {
        const folder = await Folder.getById(new TypeId(dir.typeid).id);
        const origin = folder?.origin as GitOrigin | null | undefined;
        return origin && gitOriginCloneUrl(origin) ? origin : undefined;
      } catch {
        return undefined;
      }
    },
    [gitDirFor],
  );

  // Received tasks carry folder-relative attachment entries
  // (`attachments/<name>` — packed into the task folder by the sender's
  // bundle); resolve them against the task folder for open/git checks.
  const absolutePath = useCallback(
    (path: string) => (path.startsWith('/') ? path : `${(task.asset_ref || '').replace(/\/$/, '')}/${path}`),
    [task.asset_ref],
  );

  // Open an entry's content: a FOLDER browses via the generic
  // `navigation.openFolder`; a FILE opens in its viewer.
  const openPathContent = useCallback(
    (machinePath: string, asFolder: boolean) => {
      if (asFolder) navigation.openFolder(machinePath);
      else openArtifact(machinePath, navigation);
    },
    [navigation],
  );

  const persist = useCallback(
    (next: Attachment[]) => void save({ artifacts: next as unknown as Task['artifacts'] }),
    [save],
  );

  const addPaths = useCallback(
    async (paths: string[]) => {
      const existingKeys = new Set(attachments.map(attachmentKey));
      const added: Attachment[] = [];
      for (const p of paths) {
        if (!p) continue;
        // Git folder: identity is the origin; a machine-independent offset
        // within its context folder replaces the sender's absolute path.
        const git_origin = await resolveGitOrigin(p);
        const entry = makeAttachmentEntry(p, git_origin, git_origin ? (gitDirFor(p)?.path ?? null) : null);
        const key = attachmentKey(entry);
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        added.push(entry);
      }
      if (added.length) persist([...attachments, ...added]);
    },
    [attachments, persist, resolveGitOrigin, gitDirFor],
  );

  /**
   * In-app tree drag: the row names its SOURCE entity + relative path, so copy
   * the BYTES into this task's own storage (download → upload, both existing fs
   * calls — no new endpoint). That copy is what makes the file reachable by
   * everyone: an upload on a shared task reflects to the hub automatically, and
   * a member fills their local cache from there on first open. The sender's
   * machine path never travels, because it means nothing on another disk.
   */
  const addFromEntityVfs = useCallback(
    async (sourceTypeId: TypeId, relPaths: string[]) => {
      const existingKeys = new Set(attachments.map(attachmentKey));
      const added: Attachment[] = [];
      for (const rel of relPaths) {
        const name = rel.split('/').pop() || rel;
        if (!name) continue;
        const machinePath = VFSPath.fromTypeId(sourceTypeId, rel).machinePath;

        // A GIT folder is a REFERENCE, never bytes — its content is a whole
        // repo that each machine resolves from its own checkout. Keep the
        // existing git entry shape; copying it would both lose `git_origin`
        // and try to blob-copy a directory.
        const gitOrigin = machinePath ? await resolveGitOrigin(machinePath) : undefined;
        if (gitOrigin) {
          const entry = makeAttachmentEntry(machinePath, gitOrigin, gitDirFor(machinePath)?.path ?? null);
          if (existingKeys.has(attachmentKey(entry))) continue;
          existingKeys.add(attachmentKey(entry));
          added.push(entry);
          continue;
        }
        // A plain DIRECTORY has no bytes to copy either — keep it as a local
        // path reference (opens for this user; does not travel).
        if (looksLikeFolder(name)) {
          if (!machinePath || existingKeys.has(machinePath)) continue;
          existingKeys.add(machinePath);
          added.push({ path: machinePath, label: name });
          continue;
        }

        if (existingKeys.has(name)) continue;
        try {
          const blob = await fsManager.download(sourceTypeId, rel, { asBlob: true });
          await fsManager.uploadFromBlob(task.typeId, '/', blob as Blob, name);
        } catch (e) {
          notify.error({
            title: `Could not attach ${name}`,
            message: e instanceof Error ? e.message : 'Copy failed.',
          });
          continue;
        }
        existingKeys.add(name);
        added.push({ vfs: name, label: name });
      }
      if (added.length) persist([...attachments, ...added]);
    },
    [attachments, persist, task.typeId, resolveGitOrigin, gitDirFor],
  );

  const removeEntry = useCallback(
    (key: string) => persist(attachments.filter((a) => attachmentKey(a) !== key)),
    [attachments, persist],
  );

  const pullGitFolder = useCallback(
    (a: Attachment) => {
      const url = a.git_origin ? gitOriginCloneUrl(a.git_origin) : '';
      if (!url) return null;
      return launchWizard('git-context-folder', {
        title: `Pull ${a.label}`,
        payload: {
          projectId: scopeProjectId ?? dataContext.project?.id ?? null,
          scope: 'private',
          mode: 'existing',
          url,
        },
      });
    },
    [scopeProjectId],
  );

  // Click behavior for a git context folder, matching the message chip: the
  // FIRST click launches the git-context-folder clone/install wizard (URL
  // derived from the origin the attachment carries). Once installed, later
  // clicks resolve THIS machine's own checkout from the origin and open the
  // exact subfolder — never the sender's path. Every non-git entry opens in
  // place by its local path.
  const openEntry = useCallback(
    async (a: Attachment) => {
      if (a.git_origin) {
        const key = attachmentKey(a);
        if (!installedGitPaths.has(key)) {
          const result = await pullGitFolder(a);
          if (result?.status === 'done') {
            setInstalledGitPaths((prev) => {
              const next = new Set(prev).add(key);
              writeInstalledGitPaths(task.id, next);
              return next;
            });
          }
          return;
        }
        // Installed: resolve this machine's checkout root and open the subfolder.
        const root = await resolveLocalGitRoot(a.git_origin, gitDirs);
        if (root) {
          navigation.openFolder(a.rel ? `${root}/${a.rel}` : root);
          return;
        }
        // Marked installed but no local checkout found (e.g. removed) → re-pull.
        await pullGitFolder(a);
        return;
      }
      // Bytes stored ON the task: touch the file first so a member's machine
      // fills its cache from the hub (the local download falls back there on a
      // miss), then open the resolved local path.
      if (a.vfs) {
        try {
          // Touch it first so a member's machine fills its cache from the hub,
          // then ask the SERVER where the bytes actually are — only it can
          // resolve an entity's storage root (embedded storage lives under a
          // temp dir), so `local_path` is the one trustworthy answer. Same
          // contract as a message attachment's `local_path`.
          await fsManager.download(task.typeId, a.vfs, { asBlob: true });
          const { items } = await fsManager.listDirectory(task.typeId, '/');
          const local = items.find((i) => i.display_name === a.vfs)?.local_path;
          if (!local) throw new Error('file not on local disk');
          openPathContent(local, false);
        } catch (e) {
          notify.error({
            title: `Could not open ${a.label}`,
            message: e instanceof Error ? e.message : 'File is not available yet.',
          });
        }
        return;
      }
      // Legacy entry (a bare machine path): open in place on this machine only.
      if (a.path) openPathContent(absolutePath(a.path), looksLikeFolder(a.label));
    },
    [installedGitPaths, absolutePath, openPathContent, task.id, task.typeId, gitDirs, navigation, pullGitFolder],
  );

  const pickAndAdd = useCallback(
    async (mode: 'file' | 'folder') => {
      setAddOpen(false);
      const computeNode = dataContext.computeNode;
      if (!computeNode) return;
      const picked = await computeNode.openPathDialog(undefined, mode);
      if (picked) await addPaths([picked]);
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
        // Copy the bytes onto the task rather than recording the sender's path —
        // see addFromEntityVfs.
        if (typeIdStr && entries.length) void addFromEntityVfs(new TypeId(typeIdStr), entries);
        return;
      }

      // OS drops: the desktop app exposes absolute paths on File objects; the
      // plain browser doesn't, so point the user at the + button there.
      const files = Array.from(e.dataTransfer.files ?? []);
      const withPaths = files.map((f) => (f as any).path as string | undefined).filter((p): p is string => !!p);
      if (withPaths.length) {
        void addPaths(withPaths);
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
    <div className={cn('flex min-h-0 flex-col', !readOnly && 'flex-1')}>
      <div className="flex items-center gap-1.5 border-b px-6 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {heading ?? 'Files & Folders'}
        </span>
        {!readOnly && (
          <Popover open={addOpen} onOpenChange={setAddOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Add file or folder"
                data-testid="task-attachments-add"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="start">
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
        )}
      </div>

      <div
        className={cn(
          'overflow-y-auto p-3 transition-colors',
          readOnly ? 'max-h-48' : 'min-h-0 flex-1',
          !readOnly && dragOver && 'bg-primary/5 outline-dashed outline-2 -outline-offset-4 outline-primary/40',
        )}
        onDragOver={
          readOnly
            ? undefined
            : (e) => {
                if (!droppable(e)) return;
                e.preventDefault();
                setDragOver(true);
              }
        }
        onDragLeave={readOnly ? undefined : () => setDragOver(false)}
        onDrop={readOnly ? undefined : onDrop}
        data-testid="task-attachments-drop"
      >
        {attachments.length === 0 ? (
          <div className="flex h-full min-h-24 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
            <span>No files or folders yet</span>
            {!readOnly && <span className="text-xs">Drag files or folders here, or use the + button</span>}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {attachments.map((a) => {
              const git = !!a.git_origin || (a.path ? isGitPath(a.path) : false);
              const isFolderish = git || looksLikeFolder(a.label);
              const key = attachmentKey(a);
              return (
                <div key={key} className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
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
                    onClick={() => void openEntry(a)}
                    className="min-w-0 flex-1 truncate text-left hover:underline"
                    title={a.path ?? (a.git_origin ? formatGitOrigin(a.git_origin) : a.label)}
                  >
                    {a.label}
                  </button>
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={() => removeEntry(key)}
                      className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:block"
                      title="Remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

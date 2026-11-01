import { t } from '@lingui/core/macro';
import {
  copyToClipboard,
  dataContext,
  downloadFile,
  FSRef,
  fsManager,
  fsStore,
  openTerminalFromComputeNode,
  TypeId,
  VFSPath,
} from '@sdk';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Download,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Link,
  Pencil,
  Scissors,
  SquareTerminal,
  Trash2,
  Upload,
} from 'lucide-react';
import { normalizeRel, type DockPointer } from '@src/navigation/DockPointer';
import { notify } from '@src/notifications';
import { refreshNode } from '@src/components/browseable-tree/refresh-store';
import type {
  Browseable,
  BrowseableDragData,
  DroppedFileEntry,
  ToolbarAction,
} from '@src/components/browseable-tree/types';

/**
 * File-manager operations for a filesystem tree: new file / folder, rename,
 * delete, duplicate, cut / copy / paste, drag move (Alt = copy), upload,
 * download, copy path, reveal in Finder, open in terminal.
 *
 * One implementation, decorated onto the rows of any tree whose rows are paths
 * on one VFS entity — the Files root (`fsFolderRoot`) and the Documents root
 * (`markdownFolderRoot`). The tree owns gestures (right-click, keys, drag);
 * this module owns what they do. All I/O goes through `fsManager`.
 */

/** UI services the operations need from the host view. */
export interface FsOpsHost {
  requestName: (title: string, opts?: { placeholder?: string; defaultValue?: string }) => Promise<string | null>;
  confirm: (title: string, description?: string) => Promise<boolean>;
  navigate: (pointer: DockPointer) => void;
  /** An item was renamed or moved: re-point an open view that shows it. */
  onPathMoved?: (fromMachinePath: string, toMachinePath: string) => void;
}

/** One tree's binding: which VFS entity its paths live on and how it names
 *  its folder nodes (so the right rows refresh after a change). */
export interface FsOpsCtx {
  /** Entity the I/O runs against. */
  typeId: TypeId;
  /** Entity placed in URLs (`compute_node-@local` for local files). */
  locatorTypeId: TypeId;
  /** Entity-relative path of the tree's top folder ('' = entity root). */
  anchor: string;
  /** Tree node id of the folder at `rel` (the root's id for the anchor). */
  dirNodeId: (rel: string) => string;
  /** Pointer that opens a file. */
  filePointerFor: (path: VFSPath) => DockPointer;
  /** Absolute machine path of `rel`. Defaults to the VFS mapping. */
  machinePathFor?: (rel: string) => string;
  /** The inverse: `rel` of a machine path, or null when this tree can't
   *  reach it. Defaults to stripping the leading slash when the entity maps
   *  paths one-to-one onto the machine (the local computer). */
  relForMachinePath?: (machinePath: string) => string | null;
  /** Runs after any change (e.g. drop a cached walk, reindex). */
  afterChange?: () => void | Promise<void>;
  host: FsOpsHost;
}

/** A path on the ctx's entity: one tree row. */
export interface FsItemRef {
  rel: string;
  isDir: boolean;
  label: string;
}

/** A path as it travels between trees (clipboard, drag): by machine path,
 *  because two trees can name the same disk through different entities. */
interface FsMachineItem {
  machine: string;
  isDir: boolean;
  label: string;
}

// ── shared clipboard ────────────────────────────────────────────────────────
// One per app, like the OS's: cut in one folder, paste in another tree.
interface FsClipboard {
  mode: 'copy' | 'cut';
  items: FsMachineItem[];
}
let clipboard: FsClipboard | null = null;

/** Test-only. */
export function __resetFsClipboardForTests(): void {
  clipboard = null;
}

// ── path helpers ────────────────────────────────────────────────────────────
const abs = (rel: string) => `/${normalizeRel(rel)}`;

function parentRel(rel: string): string {
  const r = normalizeRel(rel);
  const i = r.lastIndexOf('/');
  return i < 0 ? '' : r.slice(0, i);
}

function baseName(rel: string): string {
  const r = normalizeRel(rel);
  return r.slice(r.lastIndexOf('/') + 1);
}

function join(dir: string, name: string): string {
  const d = normalizeRel(dir);
  return d ? `${d}/${name}` : name;
}

/** True when `rel` is `dir` or inside it. */
function isWithin(rel: string, dir: string): boolean {
  const r = normalizeRel(rel);
  const d = normalizeRel(dir);
  return r === d || r.startsWith(`${d}/`);
}

export function isValidFsName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !/[\\/]/.test(name);
}

/** `a.md` → `a copy.md` → `a copy 2.md` … — the first name free in `dir`. */
export async function freeName(ctx: FsOpsCtx, dir: string, name: string): Promise<string> {
  if (!(await fsManager.exists(ctx.typeId, abs(join(dir, name))))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem} copy${i > 1 ? ` ${i}` : ''}${ext}`;
    if (!(await fsManager.exists(ctx.typeId, abs(join(dir, candidate))))) return candidate;
  }
  throw new Error(`No free name for ${name}`);
}

function machinePath(ctx: FsOpsCtx, rel: string): string {
  return ctx.machinePathFor ? ctx.machinePathFor(rel) : VFSPath.fromTypeId(ctx.locatorTypeId, normalizeRel(rel)).machinePath;
}

/** `rel` on this tree's entity of a machine path, or null if unreachable. */
export function relFor(ctx: FsOpsCtx, machine: string): string | null {
  if (ctx.relForMachinePath) return ctx.relForMachinePath(machine);
  // One-to-one entity (the local computer): its rel is the path sans slash.
  return machinePath(ctx, 'probe') === '/probe' ? normalizeRel(machine) : null;
}

const toMachine = (ctx: FsOpsCtx, i: FsItemRef): FsMachineItem => ({
  machine: machinePath(ctx, i.rel),
  isDir: i.isDir,
  label: i.label,
});

/** Machine items → this tree's refs; null when any is out of reach. */
function toRefs(ctx: FsOpsCtx, items: FsMachineItem[]): FsItemRef[] | null {
  const out: FsItemRef[] = [];
  for (const i of items) {
    const rel = relFor(ctx, i.machine);
    if (rel === null) return null;
    out.push({ rel, isDir: i.isDir, label: i.label });
  }
  return out;
}

// ── change signal ───────────────────────────────────────────────────────────
// The same folder can show in several trees (Files and Documents both list a
// project's docs). A change made through one tree tells the others, by the
// folders' machine paths, so every copy re-lists.
type FsChangeListener = (machinePaths: string[]) => void;
const changeListeners = new Set<FsChangeListener>();

/** Hear about folders changed through any tree. Returns the unsubscribe. */
export function onFsFoldersChanged(fn: FsChangeListener): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/** Re-list the folders that changed — in this tree and in any other tree
 *  showing them — then run the ctx's own follow-up. */
async function changed(ctx: FsOpsCtx, dirs: string[]): Promise<void> {
  const store = fsStore.getState();
  const unique = [...new Set(dirs.map(normalizeRel))];
  for (const d of unique) {
    store.invalidate(ctx.typeId, abs(d), 'browse');
    refreshNode(ctx.dirNodeId(d));
  }
  const paths = unique.map((d) => machinePath(ctx, d));
  changeListeners.forEach((fn) => fn(paths));
  await ctx.afterChange?.();
}

function fail(title: string, err: unknown): void {
  console.error(`[fsFileOps] ${title}:`, err);
  notify.error({ title, message: err instanceof Error ? err.message : undefined });
}

// ── operations ──────────────────────────────────────────────────────────────

export async function newFile(ctx: FsOpsCtx, dir: string): Promise<void> {
  const raw = await ctx.host.requestName(t`New file`, { placeholder: 'notes.md', defaultValue: 'untitled.md' });
  const name = raw?.trim();
  if (!name) return;
  if (!isValidFsName(name)) return void notify.error({ title: t`Invalid file name` });
  const rel = join(dir, name);
  try {
    if (await fsManager.exists(ctx.typeId, abs(rel))) return void notify.error({ title: t`"${name}" already exists` });
    await fsManager.writeFile(ctx.typeId, abs(rel), '');
    await changed(ctx, [dir]);
    ctx.host.navigate(ctx.filePointerFor(VFSPath.fromTypeId(ctx.locatorTypeId, rel)));
  } catch (err) {
    fail(t`Failed to create file`, err);
  }
}

export async function newFolder(ctx: FsOpsCtx, dir: string): Promise<void> {
  const raw = await ctx.host.requestName(t`New folder`, { placeholder: t`Folder name` });
  const name = raw?.trim();
  if (!name) return;
  if (!isValidFsName(name)) return void notify.error({ title: t`Invalid folder name` });
  const rel = join(dir, name);
  try {
    if (await fsManager.exists(ctx.typeId, abs(rel))) return void notify.error({ title: t`"${name}" already exists` });
    await fsManager.mkdir(ctx.typeId, abs(rel));
    await changed(ctx, [dir]);
  } catch (err) {
    fail(t`Failed to create folder`, err);
  }
}

export async function renameItem(ctx: FsOpsCtx, item: FsItemRef, rawName: string): Promise<void> {
  const name = rawName.trim();
  if (!name || name === item.label) return;
  if (!isValidFsName(name)) return void notify.error({ title: t`Invalid name` });
  const dir = parentRel(item.rel);
  const dest = join(dir, name);
  try {
    if (await fsManager.exists(ctx.typeId, abs(dest))) return void notify.error({ title: t`"${name}" already exists` });
    await fsManager.rename(ctx.typeId, abs(item.rel), name);
    fsStore.getState().invalidate(ctx.typeId, abs(item.rel), 'all');
    await changed(ctx, [dir]);
    ctx.host.onPathMoved?.(machinePath(ctx, item.rel), machinePath(ctx, dest));
  } catch (err) {
    fail(t`Failed to rename`, err);
  }
}

export async function deleteItems(ctx: FsOpsCtx, items: FsItemRef[], opts: { confirm?: boolean } = {}): Promise<void> {
  const targets = items.filter((i) => normalizeRel(i.rel) !== normalizeRel(ctx.anchor));
  if (!targets.length) return;
  const ok =
    opts.confirm === false ||
    (await ctx.host.confirm(
    targets.length > 1 ? t`Delete ${targets.length} items?` : t`Delete "${targets[0].label}"?`,
      t`This permanently deletes it from disk. This cannot be undone.`,
    ));
  if (!ok) return;
  const failed: string[] = [];
  for (const item of targets) {
    try {
      await fsManager.delete(ctx.typeId, abs(item.rel));
      fsStore.getState().invalidate(ctx.typeId, abs(item.rel), 'all');
    } catch (err) {
      console.error('[fsFileOps] delete failed:', err);
      failed.push(item.label);
    }
  }
  await changed(
    ctx,
    targets.map((i) => parentRel(i.rel)),
  );
  if (failed.length) notify.error({ title: t`Not deleted`, message: failed.join(', ') });
}

/** Copy or move `items` into `dir`. Copies take a free name; a move onto an
 *  existing name is refused rather than overwriting. */
export async function transferItems(
  ctx: FsOpsCtx,
  items: FsItemRef[],
  dir: string,
  mode: 'copy' | 'move',
): Promise<number> {
  let done = 0;
  const failed: string[] = [];
  const touched = [dir];
  for (const item of items) {
    const name = baseName(item.rel) || item.label;
    if (item.isDir && isWithin(dir, item.rel)) {
      failed.push(t`"${name}" can't go inside itself`);
      continue;
    }
    if (mode === 'move' && parentRel(item.rel) === normalizeRel(dir)) continue;
    try {
      if (mode === 'copy') {
        const free = await freeName(ctx, dir, name);
        await fsManager.copy(ctx.typeId, abs(item.rel), abs(join(dir, free)));
      } else {
        const dest = join(dir, name);
        if (await fsManager.exists(ctx.typeId, abs(dest))) {
          failed.push(t`"${name}" already exists there`);
          continue;
        }
        await fsManager.move(ctx.typeId, abs(item.rel), abs(dest));
        fsStore.getState().invalidate(ctx.typeId, abs(item.rel), 'all');
        touched.push(parentRel(item.rel));
        ctx.host.onPathMoved?.(machinePath(ctx, item.rel), machinePath(ctx, dest));
      }
      done++;
    } catch (err) {
      console.error(`[fsFileOps] ${mode} failed:`, err);
      failed.push(name);
    }
  }
  if (done) await changed(ctx, touched);
  if (failed.length) {
    notify.error({ title: mode === 'copy' ? t`Not copied` : t`Not moved`, message: failed.join(', ') });
  }
  return done;
}

export async function duplicateItems(ctx: FsOpsCtx, items: FsItemRef[]): Promise<void> {
  const failed: string[] = [];
  const dirs: string[] = [];
  for (const item of items) {
    const dir = parentRel(item.rel);
    try {
      const free = await freeName(ctx, dir, baseName(item.rel));
      await fsManager.copy(ctx.typeId, abs(item.rel), abs(join(dir, free)));
      dirs.push(dir);
    } catch (err) {
      console.error('[fsFileOps] duplicate failed:', err);
      failed.push(item.label);
    }
  }
  if (dirs.length) await changed(ctx, dirs);
  if (failed.length) notify.error({ title: t`Not duplicated`, message: failed.join(', ') });
}

export function setClipboard(ctx: FsOpsCtx, mode: 'copy' | 'cut', items: FsItemRef[]): void {
  if (!items.length) return;
  clipboard = { mode, items: items.map((i) => toMachine(ctx, i)) };
  notify.success({
    title:
      mode === 'cut'
        ? items.length > 1
          ? t`Cut ${items.length} items`
          : t`Cut "${items[0].label}"`
        : items.length > 1
          ? t`Copied ${items.length} items`
          : t`Copied "${items[0].label}"`,
  });
}

/** Something on the clipboard this tree can reach. */
export function canPaste(ctx: FsOpsCtx): boolean {
  return !!clipboard && toRefs(ctx, clipboard.items) !== null;
}

export async function paste(ctx: FsOpsCtx, dir: string): Promise<void> {
  const items = clipboard && toRefs(ctx, clipboard.items);
  if (!clipboard || !items) return;
  const { mode } = clipboard;
  const done = await transferItems(ctx, items, dir, mode === 'cut' ? 'move' : 'copy');
  // A cut is spent once pasted; a copy can be pasted again.
  if (mode === 'cut' && done) clipboard = null;
}

/** Upload OS files into `dir`, keeping each entry's sub-folders. */
export async function uploadInto(ctx: FsOpsCtx, dir: string, entries: DroppedFileEntry[]): Promise<void> {
  if (!entries.length) return;
  try {
    const byDest = new Map<string, File[]>();
    for (const { file, relPath } of entries) {
      const i = relPath.lastIndexOf('/');
      const dest = abs(i >= 0 ? join(dir, relPath.slice(0, i)) : dir);
      byDest.set(dest, [...(byDest.get(dest) ?? []), file]);
    }
    for (const [dest, files] of byDest) await fsStore.getState().uploadFiles(ctx.typeId, dest, files);
    await changed(ctx, [dir]);
    notify.success({
      title: entries.length > 1 ? t`Added ${entries.length} files` : t`Added "${entries[0].relPath}"`,
    });
  } catch (err) {
    fail(t`Failed to upload`, err);
  }
}

/** Open the OS file picker and upload what was picked into `dir`. */
export function pickAndUpload(ctx: FsOpsCtx, dir: string): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    void uploadInto(
      ctx,
      dir,
      files.map((file) => ({ file, relPath: file.name })),
    );
  };
  input.click();
}

export async function downloadItem(ctx: FsOpsCtx, item: FsItemRef): Promise<void> {
  try {
    if (item.isDir) downloadFile({ name: `${item.label}.zip`, content: await fsManager.downloadZip(ctx.typeId, abs(item.rel)) });
    else downloadFile({ name: item.label, content: (await fsManager.download(ctx.typeId, abs(item.rel), { asBlob: true })) as Blob });
  } catch (err) {
    fail(t`Failed to download`, err);
  }
}

export async function copyPaths(ctx: FsOpsCtx, items: FsItemRef[], relative: boolean): Promise<void> {
  const anchor = normalizeRel(ctx.anchor);
  const paths = items.map((i) => {
    if (!relative) return machinePath(ctx, i.rel);
    const r = normalizeRel(i.rel);
    return anchor && r.startsWith(`${anchor}/`) ? r.slice(anchor.length + 1) : r;
  });
  await copyToClipboard(paths.join('\n'));
  notify.success({ title: paths.length > 1 ? t`Copied ${paths.length} paths` : t`Copied path` });
}

/** Show the item selected in Finder / Explorer (the machine's own file manager). */
export async function revealItem(ctx: FsOpsCtx, item: FsItemRef): Promise<void> {
  try {
    await new FSRef(machinePath(ctx, item.rel), LOCAL_COMPUTE_NODE).open({ select: true });
  } catch (err) {
    fail(t`Failed to reveal`, err);
  }
}

/** Open the machine's terminal app in `dir` — the same opener the document
 *  tab's "Open in terminal" uses. */
export async function openInTerminal(ctx: FsOpsCtx, dir: string): Promise<void> {
  const computeNodeId = dataContext.computeNode?.id;
  if (!computeNodeId) return void notify.error({ title: t`No computer to open a terminal on` });
  try {
    await openTerminalFromComputeNode(computeNodeId, '', machinePath(ctx, dir));
  } catch (err) {
    fail(t`Failed to open terminal`, err);
  }
}

// ── row decoration ──────────────────────────────────────────────────────────

/** The row each built Browseable stands for, so an action on a multi-selection
 *  can map the selected rows back to paths. */
const refs = new WeakMap<Browseable, FsItemRef>();

function refsOf(rows: Browseable[] | undefined, fallback: FsItemRef): FsItemRef[] {
  const out = (rows ?? []).map((r) => refs.get(r)).filter((r): r is FsItemRef => !!r);
  return out.length ? out : [fallback];
}

/** Drag payload carried by a decorated row that had none of its own. */
export interface FsOpsDragItem extends BrowseableDragData {
  kind: 'fs-ops-item';
  items: FsMachineItem[];
}

/** The machine paths a drag carries. Understands every filesystem payload in
 *  the app, so a row dragged from the Files table, the Files tree or the
 *  Documents tree can land on any decorated folder. */
function dragItems(data: BrowseableDragData): FsMachineItem[] | null {
  if (data.kind === 'fs-ops-item' && Array.isArray(data.items)) return data.items as FsMachineItem[];
  if (data.kind === 'fs-item' && typeof data.relPath === 'string') {
    // Files-tree rows live on the local computer: rel is the path sans slash.
    const entries = (Array.isArray(data.items) && data.items.length ? data.items : [data]) as {
      relPath: string;
      isDir: boolean;
      label: string;
    }[];
    return entries.map((e) => ({ machine: `/${normalizeRel(e.relPath)}`, isDir: !!e.isDir, label: e.label }));
  }
  if ((data.kind === 'markdown-file' || data.kind === 'markdown-folder') && typeof data.absPath === 'string') {
    return [{ machine: data.absPath, isDir: data.kind === 'markdown-folder', label: data.label }];
  }
  return null;
}

/** The drag as this tree's refs, or null when it can't take it. */
function dropRefs(ctx: FsOpsCtx, data: BrowseableDragData): FsItemRef[] | null {
  const items = dragItems(data);
  return items ? toRefs(ctx, items) : null;
}

/** Can a drop of `data` land in `dir`? Reachable, not into itself, not
 *  where it already is. */
export function canDropInto(ctx: FsOpsCtx, dir: string, data: BrowseableDragData): boolean {
  const refs = dropRefs(ctx, data);
  return !!refs && refs.every((i) => !(i.isDir && isWithin(dir, i.rel)) && parentRel(i.rel) !== normalizeRel(dir));
}

type Decor = Pick<
  Browseable,
  | 'toolbar'
  | 'contextMenu'
  | 'keyActions'
  | 'onRename'
  | 'selectable'
  | 'selectionKey'
  | 'selectionType'
  | 'bulkDelete'
  | 'dragData'
  | 'canDrop'
  | 'onDrop'
  | 'onExternalFilesDrop'
  | 'downloadUrl'
>;

/**
 * Everything a row needs to act like a file manager row. `isTop` is the
 * tree's top folder: it can receive (new, paste, drop, upload) but not be
 * renamed, moved or deleted.
 */
export function fsRowDecor(ctx: FsOpsCtx, item: FsItemRef, opts: { isTop?: boolean } = {}): Decor {
  const { rel, isDir } = item;
  const top = !!opts.isTop;
  const dir = isDir ? rel : parentRel(rel);
  const key = `fs-ops:${ctx.typeId.toString()}:${normalizeRel(rel)}`;
  const many = (rows?: Browseable[]) => refsOf(rows, item);

  const rename: ToolbarAction = {
    id: `rename:${key}`,
    icon: <Pencil />,
    label: t`Rename`,
    shortcut: 'F2',
    startsRename: true,
    run: () => {},
  };
  const del: ToolbarAction = {
    id: `delete:${key}`,
    icon: <Trash2 />,
    label: t`Delete`,
    shortcut: 'Del',
    destructive: true,
    run: (rows) => deleteItems(ctx, many(rows)),
  };
  const newFileAction: ToolbarAction = {
    id: `new-file:${key}`,
    icon: <FilePlus />,
    label: t`New file`,
    showBusyIndicator: false,
    run: () => newFile(ctx, dir),
  };
  const newFolderAction: ToolbarAction = {
    id: `new-folder:${key}`,
    icon: <FolderPlus />,
    label: t`New folder`,
    showBusyIndicator: false,
    run: () => newFolder(ctx, dir),
  };

  // Hover toolbar: create on folders, rename/delete on anything movable. The
  // toolbar's delete arms on the first click, so it needs no dialog.
  const toolbar: ToolbarAction[] = [
    ...(isDir ? [newFileAction, newFolderAction] : []),
    ...(top ? [] : [rename, { ...del, run: () => deleteItems(ctx, [item], { confirm: false }) }]),
  ];

  const contextMenu = (): ToolbarAction[] => {
    const menu: ToolbarAction[] = [];
    if (!isDir) {
      menu.push({
        id: `open:${key}`,
        icon: <FolderOpen />,
        label: t`Open`,
        shortcut: '↵',
        run: () => ctx.host.navigate(ctx.filePointerFor(VFSPath.fromTypeId(ctx.locatorTypeId, normalizeRel(rel)))),
      });
    }
    if (isDir) menu.push({ ...newFileAction, separatorBefore: true }, newFolderAction);
    if (!top) {
      menu.push(
        { id: `cut:${key}`, icon: <Scissors />, label: t`Cut`, shortcut: '⌘X', separatorBefore: true, run: (rows) => setClipboard(ctx, 'cut', many(rows)) },
        { id: `copy:${key}`, icon: <Copy />, label: t`Copy`, shortcut: '⌘C', run: (rows) => setClipboard(ctx, 'copy', many(rows)) },
      );
    }
    if (isDir) {
      menu.push({
        id: `paste:${key}`,
        icon: <ClipboardPaste />,
        label: t`Paste`,
        shortcut: '⌘V',
        separatorBefore: top,
        disabled: () => !canPaste(ctx),
        run: () => paste(ctx, dir),
      });
    }
    if (!top) {
      menu.push(
        { id: `duplicate:${key}`, icon: <CopyPlus />, label: t`Duplicate`, shortcut: '⌘D', run: (rows) => duplicateItems(ctx, many(rows)) },
        { ...rename, separatorBefore: true },
        del,
      );
    }
    menu.push(
      { id: `copy-path:${key}`, icon: <Link />, label: t`Copy path`, separatorBefore: true, run: (rows) => copyPaths(ctx, many(rows), false) },
      { id: `copy-rel-path:${key}`, icon: <Link />, label: t`Copy relative path`, run: (rows) => copyPaths(ctx, many(rows), true) },
      { id: `reveal:${key}`, icon: <FolderOpen />, label: t`Reveal in Finder`, run: () => revealItem(ctx, item) },
    );
    if (isDir) {
      menu.push(
        { id: `terminal:${key}`, icon: <SquareTerminal />, label: t`Open in terminal`, run: () => openInTerminal(ctx, dir) },
        { id: `upload:${key}`, icon: <Upload />, label: t`Upload files here…`, separatorBefore: true, run: () => pickAndUpload(ctx, dir) },
      );
    }
    menu.push({
      id: `download:${key}`,
      icon: <Download />,
      label: isDir ? t`Download as zip` : t`Download`,
      separatorBefore: !isDir,
      run: () => downloadItem(ctx, item),
    });
    return menu;
  };

  return {
    toolbar,
    contextMenu,
    keyActions: {
      ...(top
        ? {}
        : {
            delete: (rows) => deleteItems(ctx, many(rows)),
            copy: (rows) => setClipboard(ctx, 'copy', many(rows)),
            cut: (rows) => setClipboard(ctx, 'cut', many(rows)),
            duplicate: (rows) => duplicateItems(ctx, many(rows)),
          }),
      paste: () => paste(ctx, dir),
    },
    onRename: top ? undefined : (name) => renameItem(ctx, item, name),
    selectable: !top,
    selectionKey: top ? undefined : key,
    selectionType: 'file',
    bulkDelete: top
      ? undefined
      : {
          run: () => fsManager.delete(ctx.typeId, abs(rel)),
          refreshId: ctx.dirNodeId(parentRel(rel)),
        },
    dragData: top
      ? undefined
      : ({ kind: 'fs-ops-item', id: key, label: item.label, items: [toMachine(ctx, item)] } satisfies FsOpsDragItem),
    ...(isDir
      ? {
          canDrop: (data: BrowseableDragData) => canDropInto(ctx, rel, data),
          onDrop: async (data: BrowseableDragData, o?: { copy: boolean }) => {
            const refs = dropRefs(ctx, data);
            if (refs) await transferItems(ctx, refs, rel, o?.copy ? 'copy' : 'move');
          },
          onExternalFilesDrop: (entries: DroppedFileEntry[]) => uploadInto(ctx, rel, entries),
        }
      : { downloadUrl: absoluteUrl(fsManager.getDownloadUrl(ctx.typeId, abs(rel))) }),
  };
}

function absoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.href).toString();
  } catch {
    return url;
  }
}

/** Decorate a built row in place and remember which path it stands for. A
 *  row that already has a drag payload keeps it — other drop targets (the
 *  Dependencies rows) read that payload. */
export function withFsOps<T extends Browseable>(
  node: T,
  ctx: FsOpsCtx,
  item: FsItemRef,
  opts?: { isTop?: boolean },
): T {
  const decor = fsRowDecor(ctx, item, opts);
  if (node.dragData) delete decor.dragData;
  // The row's own actions (search indexing, knowledge browser…) stay, after ours.
  decor.toolbar = [...(decor.toolbar ?? []), ...(node.toolbar ?? [])];
  const decorated = Object.assign(node, decor);
  refs.set(decorated, item);
  return decorated;
}

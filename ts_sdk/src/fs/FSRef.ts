/**
 * FSRef — universal file/folder reference for the frontend.
 *
 * Wraps a VFS path + compute node TypeId with async read/write/exists methods.
 * Mirrors flow_sdk/fs_store/fs_ref.py FSRef on the Python side.
 */

import { ActionInfo } from '../models/ActionInfo';
import { TypeId } from '../models/TypeId';
import type { FileUpload } from '../services/FileUpload';

export type FSRefType = 'text' | 'json' | 'folder' | 'file';

export interface FSRefJson {
  path: string;
  ref_type: FSRefType;
  read_only: boolean;
  type_id: string;
}

export class FSRef {
  readonly path: string;
  readonly refType: FSRefType;
  readonly readOnly: boolean;
  protected readonly typeId: TypeId;

  constructor(path: string, typeId: TypeId, refType: FSRefType = 'file', readOnly = false) {
    this.path = path;
    this.typeId = typeId;
    this.refType = refType;
    this.readOnly = readOnly;
  }

  /**
   * The local compute node that can service OS- and Git-specific file actions.
   *
   * Hub-backed refs deliberately return null: they still support the ordinary
   * FSRef read/write/download contract, but their TypeId identifies the asset
   * rather than a machine whose filesystem can be opened or queried with git.
   */
  get localComputeNodeId(): string | null {
    return this.typeId.type === 'compute_node' ? this.typeId.id : null;
  }

  static fromJson(json: FSRefJson): FSRef {
    return new FSRef(json.path, new TypeId(json.type_id), json.ref_type, json.read_only);
  }

  child(name: string): FSRef {
    const sep = this.path.endsWith('/') ? '' : '/';
    return new FSRef(`${this.path}${sep}${name}`, this.typeId, 'file', this.readOnly);
  }

  /**
   * Resolve a relative path (`../shared/base.json`, `sibling.html`) against this
   * ref's own location, returning a ref to the target.
   *
   * Resolves against this ref's own path INCLUDING its last segment, so for a
   * file ref one `..` cancels the filename rather than climbing a directory:
   * `x/y/deck.html` + `../t.json` is `x/y/t.json`, its sibling. That is the
   * behaviour deck manifests are written against. Pair it with {@link vpath} to
   * address the result.
   *
   * Here rather than at a call site: DeckViewer had this loop inline and then
   * hand-built `${typeId}/${path}` — the string {@link vpath} already produces
   * — which meant reaching past `typeId`, deliberately not public. A path rule
   * copied per consumer is a path rule that drifts.
   */
  resolve(rel: string): FSRef {
    const segs = this.path.split('/').filter(Boolean);
    for (const part of rel.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') segs.pop();
      else segs.push(part);
    }
    return new FSRef(segs.join('/'), this.typeId, 'file', this.readOnly);
  }

  get parent(): FSRef {
    const idx = this.path.lastIndexOf('/');
    const parentPath = idx > 0 ? this.path.slice(0, idx) : '/';
    return new FSRef(parentPath, this.typeId, 'folder', this.readOnly);
  }

  async read(): Promise<string> {
    const { fsManager } = await import('../services/fsService');
    const result = await fsManager.download(this.typeId, this.path);
    return typeof result === 'string' ? result : String(result);
  }

  /**
   * Binary counterpart of {@link read} — the same VFS download, asked for as a
   * Blob. Without it a caller with a binary file (a .xlsx, an image) has no way
   * through this class and has to reach past it for the ref's TypeId, which is
   * deliberately not public.
   */
  async readBlob(): Promise<Blob> {
    const { fsManager } = await import('../services/fsService');
    const result = await fsManager.download(this.typeId, this.path, { asBlob: true });
    return result instanceof Blob ? result : new Blob([result]);
  }

  async write(content: string): Promise<void> {
    if (this.readOnly) throw new Error(`Cannot write read-only FSRef: ${this.path}`);
    const { fsManager } = await import('../services/fsService');
    await fsManager.writeFile(this.typeId, this.path, content);
  }

  /** Upload a file into this folder through the ordinary entity VFS action. */
  async uploadFile(file: File): Promise<FileUpload> {
    if (this.readOnly) throw new Error(`Cannot upload to read-only FSRef: ${this.path}`);
    const { fsManager } = await import('../services/fsService');
    return fsManager.uploadFile(this.typeId, this.path, file);
  }

  /** Browser URL for this file through the ordinary entity VFS action. */
  getDownloadUrl(): string {
    const action = new ActionInfo('fs', this.typeId.type, this.typeId.id, 'GET');
    const cleanPath = this.path.replace(/^\/+/, '');
    action.subpath = cleanPath ? `download/${cleanPath}` : 'download';
    return action.fullActionUrl;
  }

  async exists(): Promise<boolean> {
    // Deliberately NOT "attempt a download and catch the 404". That probe made a
    // routine question ("has this been saved yet?") emit a browser-level
    // `Failed to load resource: 404` before any application code could run, and
    // it also transferred the whole file just to learn that it was there.
    const { fsManager } = await import('../services/fsService');
    return await fsManager.exists(this.typeId, this.path);
  }

  /**
   * Read this file, or `null` when it does not exist yet.
   *
   * The sanctioned way to read a maybe-unsaved document. `read()`-and-catch emits a
   * browser-level 404 for the ordinary "not created yet" case, and `exists()` then
   * `read()` costs two round trips on the common path — this is one request that
   * answers both. Encoded here rather than at each editor so the next caller cannot
   * re-invent the noisy pattern.
   */
  async readIfExists(): Promise<string | null> {
    const { fsManager } = await import('../services/fsService');
    return await fsManager.readIfExists(this.typeId, this.path);
  }

  /**
   * Recovery primitive — write `content` (default empty) at this path,
   * creating parent directories server-side. Pair with ``exists()`` for the
   * editor's "read-or-recover" branch:
   *
   *     if (!(await fsRef.exists())) await fsRef.create();
   *
   * This is **not** the normal create path — Entity.save() →
   * Record.upsert_main_ref handles routine creation with the correct default
   * body. ``create()`` exists so a stale entity row pointing at a missing
   * file never produces a hard 404 in the editor.
   */
  async create(content: string = ''): Promise<void> {
    if (this.readOnly) throw new Error(`Cannot create read-only FSRef: ${this.path}`);
    const { fsManager } = await import('../services/fsService');
    await fsManager.writeFile(this.typeId, this.path, content);
  }

  get vpath(): string {
    // Format: "{type}-{id}/{path_without_leading_slash}"
    const typeId = this.typeId;
    const cleanPath = this.path.startsWith('/') ? this.path.slice(1) : this.path;
    return `${typeId.type}-${typeId.id}/${cleanPath}`;
  }

  async ls(): Promise<FSRef[]> {
    const { fsManager } = await import('../services/fsService');
    const result = await fsManager
      .listDirectory(this.typeId, this.path)
      .catch(() => ({ items: [] as Array<{ name: string; relativePath?: string }> }));
    return (result.items ?? []).map((item: { name: string; relativePath?: string }) => {
      const itemPath =
        item.relativePath ?? (this.path.endsWith('/') ? `${this.path}${item.name}` : `${this.path}/${item.name}`);
      return new FSRef(itemPath, this.typeId, 'file', this.readOnly);
    });
  }

  async delete(): Promise<void> {
    if (this.readOnly) throw new Error(`Cannot delete read-only FSRef: ${this.path}`);
    const { fsManager } = await import('../services/fsService');
    await fsManager.delete(this.typeId, this.path).catch(() => {});
  }

  /**
   * Reveal this path in the OS file manager (Finder / Explorer).
   * Folders open directly; files can be revealed with `{ select: true }`.
   * Dispatches to the compute_node `open-external` action via this ref's typeId.
   */
  async open(options?: { select?: boolean }): Promise<{ opened: string; selected?: boolean } | null> {
    const { openExternalFromComputeNode } = await import('../entities/compute-node/system-profile');
    return openExternalFromComputeNode(this.typeId.id, this.path, options);
  }

  children(): FSRef[] {
    return [];
  }

  toJSON(): FSRefJson {
    return {
      path: this.path,
      ref_type: this.refType,
      read_only: this.readOnly,
      type_id: `${this.typeId.type}-${this.typeId.id}`,
    };
  }

  toString(): string {
    return `FSRef(${this.path})`;
  }
}

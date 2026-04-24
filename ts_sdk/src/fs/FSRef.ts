/**
 * FSRef — universal file/folder reference for the frontend.
 *
 * Wraps a VFS path + compute node TypeId with async read/write/exists methods.
 * Mirrors flow_sdk/fs_store/fs_ref.py FSRef on the Python side.
 */

import { TypeId } from '../models/TypeId';

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

  static fromJson(json: FSRefJson): FSRef {
    return new FSRef(json.path, new TypeId(json.type_id), json.ref_type, json.read_only);
  }

  child(name: string): FSRef {
    const sep = this.path.endsWith('/') ? '' : '/';
    return new FSRef(`${this.path}${sep}${name}`, this.typeId);
  }

  get parent(): FSRef {
    const idx = this.path.lastIndexOf('/');
    const parentPath = idx > 0 ? this.path.slice(0, idx) : '/';
    return new FSRef(parentPath, this.typeId);
  }

  async read(): Promise<string> {
    const { fsManager } = await import('../services/fsService');
    const result = await fsManager.download(this.typeId, this.path);
    return typeof result === 'string' ? result : String(result);
  }

  async write(content: string): Promise<void> {
    const { fsManager } = await import('../services/fsService');
    await fsManager.writeFile(this.typeId, this.path, content);
  }

  async exists(): Promise<boolean> {
    try {
      const { fsManager } = await import('../services/fsService');
      await fsManager.download(this.typeId, this.path);
      return true;
    } catch {
      return false;
    }
  }

  get vpath(): string {
    // Format: "{type}-{id}/{path_without_leading_slash}"
    const typeId = this.typeId;
    const cleanPath = this.path.startsWith('/') ? this.path.slice(1) : this.path;
    return `${typeId.type}-${typeId.id}/${cleanPath}`;
  }

  async ls(): Promise<FSRef[]> {
    const { fsManager } = await import('../services/fsService');
    const result = await fsManager.listDirectory(this.typeId, this.path).catch(() => ({ items: [] as Array<{name: string; relativePath?: string}> }));
    return (result.items ?? []).map((item: {name: string; relativePath?: string}) => {
      const itemPath = item.relativePath ?? (this.path.endsWith('/') ? `${this.path}${item.name}` : `${this.path}/${item.name}`);
      return new FSRef(itemPath, this.typeId);
    });
  }

  async delete(): Promise<void> {
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

import { dataManager } from '../APIEntity';
import { ActionInfo, TypeId } from '../models';
import { DownloadOptions } from '../models/FSOptions';
import { fsManager, BrowseResult, SymlinkResolveResult } from '../services/fsService';
import { VFSPath } from '../utils/vfs-path';

/**
 * FSEntry — one entry in a directory listing (file, directory, or symlink).
 *
 * A transient VALUE object, NOT an entity: it is never saved, never registered,
 * has no graph row. It is the return shape of every fs browse/list call. Files
 * that need a persisted, addressable row use the `File`/`Folder` entities.
 *
 * (Replaced the old `FSItem` entity. Kept the same field/getter/method surface
 * — delegating to `fsManager` — so consumers only change the type name.)
 */
export class FSEntry {
  is_dir?: boolean;
  size?: number;
  last_modified?: number;
  display_name?: string;
  vfs_abs_path: string;
  symlink_target?: string;
  /** Resolved absolute path on THIS machine, set by the server only when the
   *  bytes are on local disk. Transient (API responses only). Mirrors a message
   *  attachment's `local_path`: only the server can resolve an entity's storage
   *  root, so never derive this client-side. */
  local_path?: string;
  // Computed once at construction so it survives Immer's produce() in stores
  // that hold FSEntry instances — Immer strips class getters but preserves
  // enumerable instance fields. Consumers (sort comparators, find-by-name)
  // can rely on .name being defined after the item passes through any cache.
  name: string;

  /** Cached VFSPath instance for efficient path operations */
  private _vfsPath?: VFSPath;

  constructor(entry: Partial<FSEntry> = {}) {
    this.is_dir = entry.is_dir;
    this.size = entry.size;
    this.last_modified = entry.last_modified;
    this.display_name = entry.display_name;
    this.vfs_abs_path = entry.vfs_abs_path || '';
    this.symlink_target = entry.symlink_target;
    this.local_path = entry.local_path;
    this.name = this._computeName();
  }

  private _computeName(): string {
    const filename = this.vfsPath.filename;
    if (!filename) return '';
    if (filename === '.') return 'Root';
    return filename;
  }

  /**
   * Get the parsed VFSPath object for this item
   * Provides type-safe access to path components
   */
  get vfsPath(): VFSPath {
    if (!this._vfsPath) {
      this._vfsPath = VFSPath.parse(this.vfs_abs_path);
    }
    return this._vfsPath;
  }

  /**
   * @deprecated Use vfsPath.entitySubPath instead
   */
  get vfs_file_name(): string | undefined {
    return this.vfsPath.entitySubPath || undefined;
  }

  get title() {
    return this.display_name || this.vfs_file_name;
  }

  /**
   * Get the parent entity TypeId
   */
  get parentTypeId(): TypeId {
    const typeId = this.vfsPath.typeId;
    if (!typeId) {
      throw new Error('Invalid vfs_abs_path: missing entity type or id');
    }
    return typeId;
  }

  /**
   * Get the file path relative to the parent entity
   */
  get relativePath(): string {
    return this.vfsPath.entitySubPath;
  }

  /**
   * Legacy method for backward compatibility
   * @deprecated Use download() instead
   */
  async fetchContent(): Promise<string | undefined> {
    try {
      const actionInfo = new ActionInfo(
        `fs/download/${this.vfs_file_name}`,
        this.vfsPath.type || undefined,
        this.vfsPath.id || undefined,
        'GET',
        true,
      );
      const response: string = await dataManager.callAction<undefined, string>(actionInfo);
      return response;
    } catch (e) {
      console.error('Failed to fetch fs entry content: ', e);
    }
  }

  /**
   * Download file content using FSManager
   * @param options - Download options (encoding, asBlob, etc.)
   * @returns File content as string or Blob
   * @throws Error if the download fails
   */
  async download(options?: DownloadOptions): Promise<string | Blob> {
    return await fsManager.download(this.parentTypeId, this.relativePath, options);
  }

  /**
   * Delete this file using FSManager
   * @throws Error if the deletion fails
   */
  async deleteFile(): Promise<void> {
    await fsManager.delete(this.parentTypeId, this.relativePath);
  }

  /**
   * Open this file or folder in the OS default application
   * Only available in desktop and local environments
   * @returns Success message
   * @throws Error if the open fails or environment doesn't support it
   */
  async open(): Promise<string> {
    return await fsManager.open(this.parentTypeId, this.relativePath);
  }

  /**
   * Get parent directory listing using FSManager
   * @returns BrowseResult with directory contents
   * @throws Error if listing fails
   */
  async getParentDirectory(): Promise<BrowseResult> {
    const parentPath = this.vfsPath.parent.entitySubPath || '/';
    return await fsManager.listDirectory(this.parentTypeId, parentPath);
  }

  /**
   * Check if this item is a symbolic link
   */
  get isSymlink(): boolean {
    return this.symlink_target != null;
  }

  /**
   * Get the symlink target path (if this is a symlink)
   */
  get symlinkTarget(): string | undefined {
    return this.symlink_target;
  }

  /**
   * Resolve this symlink to get its target information
   * Only works if this item is a symlink
   * @returns Object with target path, validity, and original path
   * @throws Error if this item is not a symlink
   */
  async resolveSymlink(): Promise<SymlinkResolveResult> {
    if (!this.isSymlink) {
      throw new Error('Item is not a symlink');
    }
    return await fsManager.resolveSymlink(this.parentTypeId, this.relativePath);
  }
}

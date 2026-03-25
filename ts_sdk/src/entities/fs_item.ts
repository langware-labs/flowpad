import { APIEntity, dataManager, registerEntity } from '../APIEntity';
import { ActionInfo, TypeId } from '../models';
import { DownloadOptions } from '../models/FSOptions';
import { fsManager, BrowseResult, SymlinkResolveResult } from '../services/fsService';
import { VFSPath } from '../utils/vfs-path';

@registerEntity
export class FSItem extends APIEntity<FSItem> {
  static type: string = 'fs_item';
  encoding?: string;
  is_dir?: boolean;
  size?: number;
  last_modified?: number;
  display_name?: string;
  vfs_abs_path: string;
  upload_progress?: number;
  symlink_target?: string;

  /** Cached VFSPath instance for efficient path operations */
  private _vfsPath?: VFSPath;

  constructor(entity: Partial<FSItem> = {}) {
    super(entity);
    this.encoding = entity.encoding;
    this.is_dir = entity.is_dir;
    this.size = entity.size;
    this.last_modified = entity.last_modified;
    this.display_name = entity.display_name;
    this.vfs_abs_path = entity.vfs_abs_path || '';
    this.upload_progress = entity.upload_progress;
    this.symlink_target = entity.symlink_target;
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
   * @deprecated Use vfsPath.type instead
   */
  get vfs_entity_type(): string | undefined {
    return this.vfsPath.type || undefined;
  }

  /**
   * @deprecated Use vfsPath.id instead
   */
  get vfs_entity_id(): string | undefined {
    return this.vfsPath.id || undefined;
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

  get name() {
    const filename = this.vfsPath.filename;
    if (!filename) return '';
    // Handle root folder case where name is "."
    if (filename === '.') return 'Root';
    return filename;
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
        this.vfs_entity_type,
        this.vfs_entity_id,
        'GET',
        true,
      );
      await dataManager.getByTypeId(new TypeId(this.vfs_entity_type!, this.vfs_entity_id));
      const response: string = await dataManager.callAction<undefined, string>(actionInfo);
      return response;
    } catch (e) {
      console.error('Failed to fetch fs item content: ', e);
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
    // Also delete the entity from the store
    await this.delete();
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

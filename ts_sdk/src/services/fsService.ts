import { dataManager } from '../APIEntity';
import { FSItem } from '../entities/fs_item';
import { ActionInfo, TypeId } from '../models';
import { DownloadOptions, UploadOptions } from '../models/FSOptions';
import { FileUpload } from './FileUpload';

/**
 * BrowseResult - Result of a directory listing operation
 */
export interface BrowseResult {
  items: FSItem[];
  path: string;
  totalSize: number;
  itemCount: number;
}

/**
 * SymlinkResolveResult - Result of resolving a symbolic link
 */
export interface SymlinkResolveResult {
  target: string;
  is_valid: boolean;
  original_path: string;
}

/**
 * FSManager - Centralized service for file system operations
 * Provides a consistent API for browse, upload, download, and delete operations
 * All methods throw errors on failure (consistent with SDK patterns)
 */
export class FSManager {
  private static instance: FSManager;

  static getInstance(): FSManager {
    if (!FSManager.instance) {
      FSManager.instance = new FSManager();
    }
    return FSManager.instance;
  }

  /**
   * Create ActionInfo for FS operations
   */
  private createFSAction(typeid: TypeId, action: string, path?: string, method: string = 'GET'): ActionInfo {
    const actionInfo = new ActionInfo('fs', typeid.type, typeid.id, method as any);

    // Build subpath: action/path (e.g., "browse", "browse/subdir", "download/file.txt")
    let subPath: string = action;
    if (path && path !== '/') {
      const cleanPath = path.replace(/^\/+/, '');
      if (cleanPath) {
        subPath = `${action}/${cleanPath}`;
      }
    }

    actionInfo.subpath = subPath;
    return actionInfo;
  }

  /**
   * List directory contents
   * @param typeid - Entity TypeId that owns the file system
   * @param path - Relative path within the entity's file system (default: "/")
   * @returns BrowseResult containing items
   * @throws Error if the operation fails
   */
  async listDirectory(typeid: TypeId, path: string = '/'): Promise<BrowseResult> {
    const actionInfo = this.createFSAction(typeid, 'browse', path, 'GET');
    const payload = await dataManager.callAction<undefined, unknown>(actionInfo);
    let rawItems: unknown[] = [];

    if (Array.isArray(payload)) {
      rawItems = payload;
    } else if (payload == null) {
      // Some backend paths can return null for empty directories; treat as empty list.
      rawItems = [];
    } else {
      console.warn('[FSManager] Unexpected browse payload; falling back to empty list:', payload);
      rawItems = [];
    }

    const fsItems = rawItems.map((item) => new FSItem(item as any));
    const totalSize = fsItems.reduce((sum, item) => sum + (item.size || 0), 0);

    return {
      items: fsItems,
      path,
      totalSize,
      itemCount: fsItems.length,
    };
  }

  /**
   * Check if a file or directory exists
   * @param typeid - Entity TypeId
   * @param path - File path to check
   * @returns true if exists, false otherwise
   */
  async exists(typeid: TypeId, path: string): Promise<boolean> {
    try {
      const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
      const filename = path.substring(path.lastIndexOf('/') + 1);

      // If no filename (path is root or directory), try to list it
      if (!filename || path === '/') {
        await this.listDirectory(typeid, path);
        return true;
      }

      // Check if file exists in parent directory
      const parentBrowse = await this.listDirectory(typeid, parentPath);
      // FSItem.name returns full relative path, extract just the name for comparison
      return parentBrowse.items.some((item) => {
        const itemName = item.name.split('/').pop() || item.name;
        return itemName === filename;
      });
    } catch {
      return false;
    }
  }

  /**
   * Get download URL for a file
   * @param typeid - Entity TypeId
   * @param path - File path
   * @returns URL for the file
   */
  getDownloadUrl(typeid: TypeId, path: string): string {
    return this.createFSAction(typeid, 'download', path, 'GET').fullActionUrl;
  }

  /**
   * Download a file as string or Blob
   * @param typeid - Entity TypeId
   * @param path - File path to download
   * @param options - Download options (encoding, asBlob, offset, size)
   * @returns File content as string or Blob
   * @throws Error if the download fails
   */
  async download(typeid: TypeId, path: string, options?: DownloadOptions): Promise<string | Blob> {
    const actionInfo = this.createFSAction(typeid, 'download', path, 'GET');
    actionInfo.isRawResponse = true;
    actionInfo.responseType = options?.asBlob ? 'blob' : 'text';

    const content = await dataManager.callAction<undefined, string | Blob>(actionInfo);
    return content;
  }

  /**
   * Download a file as a readable stream (for large files)
   * @param typeid - Entity TypeId
   * @param path - File path to download
   * @returns ReadableStream or null
   * @throws Error if streaming fails
   */
  async downloadAsStream(typeid: TypeId, path: string): Promise<ReadableStream<Uint8Array> | null> {
    const actionInfo = this.createFSAction(typeid, 'download', path, 'GET');
    actionInfo.isRawResponse = true;
    actionInfo.responseType = 'stream';

    const stream = await dataManager.callAction<undefined, ReadableStream<Uint8Array>>(actionInfo);
    return stream;
  }

  /**
   * Download directory as ZIP archive
   * @param typeid - Entity TypeId
   * @param path - Directory path to download (default: "/")
   * @returns Blob containing ZIP data
   * @throws Error if the download fails
   */
  async downloadZip(typeid: TypeId, path: string = '/'): Promise<Blob> {
    const actionInfo = this.createFSAction(typeid, 'download_zip', path, 'GET');
    actionInfo.isRawResponse = true;
    actionInfo.responseType = 'blob';

    const blob = await dataManager.callAction<undefined, Blob>(actionInfo);
    return blob;
  }

  /**
   * Upload a single file
   * @param typeid - Entity TypeId
   * @param destinationPath - Destination directory path (e.g., "/uploads/")
   * @param file - File to upload
   * @param options - Upload options (onProgress, encoding, overwrite)
   * @returns FileUpload object for tracking progress
   * @throws Error if the upload fails
   */
  async uploadFile(typeid: TypeId, destinationPath: string, file: File, options?: UploadOptions): Promise<FileUpload> {
    const uploads = await this.uploadFiles(typeid, destinationPath, [file], options);
    return uploads[0];
  }

  /**
   * Upload multiple files
   * @param typeid - Entity TypeId
   * @param destinationPath - Destination directory path
   * @param files - Array of files to upload
   * @param options - Upload options
   * @returns Array of FileUpload objects for tracking progress
   * @throws Error if the upload fails
   */
  async uploadFiles(
    typeid: TypeId,
    destinationPath: string,
    files: File[],
    options?: UploadOptions,
  ): Promise<FileUpload[]> {
    try {
      const formData = new FormData();

      files.forEach((file, index) => {
        formData.append(`file_${index}`, file, file.name);
      });

      const actionInfo = this.createFSAction(typeid, 'upload', destinationPath, 'POST');
      actionInfo.bodyParameters = formData;

      const uploadedItems = await dataManager.callAction<FormData, FSItem[]>(actionInfo);
      const fsItems = uploadedItems.map((item) => new FSItem(item));
      return this.createFileUploads(fsItems, options);
    } catch (error: any) {
      if (!this.shouldFallbackToWriteUpload(error)) {
        throw error;
      }

      const uploadedViaWrite: FSItem[] = [];
      for (const file of files) {
        // Only fall back to text write for text files — binary files (images, etc.)
        // cannot be round-tripped through a UTF-8 text encoder without corruption.
        if (file.type && !file.type.startsWith('text/') && file.type !== 'application/json') {
          throw new Error(`Cannot upload binary file '${file.name}': server does not support multipart upload for this content type`);
        }
        const content = await this.readFileAsText(file);
        const fullPath = this.joinDestinationPath(destinationPath, file.name);
        const writtenItem = await this.writeFile(typeid, fullPath, content);
        uploadedViaWrite.push(writtenItem);
      }

      return this.createFileUploads(uploadedViaWrite, options);
    }
  }

  private createFileUploads(fsItems: FSItem[], options?: UploadOptions): FileUpload[] {
    return fsItems.map((fsItem) => {
      const fileUpload = new FileUpload(fsItem);

      // For sync uploads (common in tests/small files), mark immediately complete.
      const initialProgress = fsItem.upload_progress;
      if (initialProgress === undefined || initialProgress === 0 || initialProgress >= 100) {
        fileUpload._updateProgress(100);
        options?.onProgress?.(100, fsItem.name);
        return fileUpload;
      }

      // Keep streaming progress behavior for async upload implementations.
      const unsubscribe = this.watchUploadProgress(fsItem.typeId, (progress) => {
        fileUpload._updateProgress(progress);
        options?.onProgress?.(progress, fsItem.name);
      });

      fileUpload._setUnsubscribe(unsubscribe);
      setTimeout(() => {
        if (!fileUpload.completed) {
          fileUpload._setError(new Error(`Upload timeout for ${fsItem.name}`));
        }
      }, 60000);

      return fileUpload;
    });
  }

  private shouldFallbackToWriteUpload(error: unknown): boolean {
    const err = error as any;
    const message = String(err?.message || '').toLowerCase();
    const detail = String(err?.response?.data?.detail || '').toLowerCase();
    const serverMessage = String(err?.response?.data?.message || '').toLowerCase();
    return (
      message.includes('no files found in request') ||
      detail.includes('no files found in request') ||
      serverMessage.includes('no files found in request')
    );
  }

  private async readFileAsText(file: File): Promise<string> {
    if (typeof (file as any).text === 'function') {
      return (file as any).text();
    }

    if (typeof (file as any).arrayBuffer === 'function') {
      const buffer = await (file as any).arrayBuffer();
      return new TextDecoder().decode(buffer);
    }

    if (typeof FileReader !== 'undefined') {
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`Unable to read file content for ${file.name}`));
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.readAsText(file);
      });
    }

    throw new Error(`Unable to read file content for ${file.name}`);
  }

  private joinDestinationPath(destinationPath: string, filename: string): string {
    const normalizedDestination = destinationPath === '/' ? '' : destinationPath.replace(/\/+$/, '');
    const normalizedFilename = filename.replace(/^\/+/, '');
    return `${normalizedDestination}/${normalizedFilename}`.replace(/^\/+/, '');
  }

  /**
   * Upload a file from Blob
   * @param typeid - Entity TypeId
   * @param destinationPath - Destination directory path
   * @param blob - Blob to upload
   * @param filename - Name for the uploaded file
   * @param options - Upload options
   * @returns FileUpload object for tracking progress
   * @throws Error if the upload fails
   */
  async uploadFromBlob(
    typeid: TypeId,
    destinationPath: string,
    blob: Blob,
    filename: string,
    options?: UploadOptions,
  ): Promise<FileUpload> {
    const file = new File([blob], filename, { type: blob.type });
    return this.uploadFile(typeid, destinationPath, file, options);
  }

  /**
   * Upload and extract a ZIP file
   * @param typeid - Entity TypeId
   * @param destinationPath - Destination directory path
   * @param zipFile - ZIP file to upload
   * @returns Success message
   * @throws Error if the upload fails
   */
  async uploadZip(typeid: TypeId, destinationPath: string, zipFile: File): Promise<string> {
    const formData = new FormData();
    formData.append('file', zipFile, zipFile.name);

    const actionInfo = this.createFSAction(typeid, 'upload_zip', destinationPath, 'POST');
    actionInfo.bodyParameters = formData;

    return await dataManager.callAction<FormData, string>(actionInfo);
  }

  /**
   * Delete a file or directory
   * @param typeid - Entity TypeId
   * @param path - Path to delete
   * @returns void
   * @throws Error if the deletion fails
   */
  async delete(typeid: TypeId, path: string): Promise<void> {
    const actionInfo = this.createFSAction(typeid, 'delete', path, 'DELETE');
    await dataManager.callAction<undefined, any>(actionInfo);
  }

  /**
   * Rename a file or directory (same parent directory)
   * @param typeid - Entity TypeId
   * @param path - Current path of the file/directory
   * @param newName - New name for the file/directory (just the name, not full path)
   * @returns FSItem of the renamed file
   * @throws Error if the rename fails
   */
  async rename(typeid: TypeId, path: string, newName: string): Promise<FSItem> {
    // Validate newName doesn't contain path separators
    if (newName.includes('/')) {
      throw new Error('New name cannot contain path separators. Use move() for moving to different directories.');
    }

    const actionInfo = this.createFSAction(typeid, 'rename', path, 'POST');
    actionInfo.queryParameters = { new_name: newName };
    const item = await dataManager.callAction<undefined, FSItem>(actionInfo);
    return new FSItem(item);
  }

  /**
   * Copy a file or directory to a new location
   * @param typeid - Entity TypeId
   * @param sourcePath - Path to the source file/directory
   * @param destPath - Destination path (including filename)
   * @returns FSItem of the copied file
   * @throws Error if the copy fails
   */
  async copy(typeid: TypeId, sourcePath: string, destPath: string): Promise<FSItem> {
    // Validate destination path includes a filename
    if (destPath.endsWith('/')) {
      throw new Error('Destination path must include a filename');
    }

    const actionInfo = this.createFSAction(typeid, 'copy', sourcePath, 'POST');
    actionInfo.queryParameters = { dest_path: destPath };
    const item = await dataManager.callAction<undefined, FSItem>(actionInfo);
    return new FSItem(item);
  }

  /**
   * Move a file or directory to a new location
   * @param typeid - Entity TypeId
   * @param sourcePath - Path to the source file/directory
   * @param destPath - Destination path (including filename)
   * @returns FSItem of the moved file
   * @throws Error if the move fails
   */
  async move(typeid: TypeId, sourcePath: string, destPath: string): Promise<FSItem> {
    const actionInfo = this.createFSAction(typeid, 'move', sourcePath, 'POST');
    actionInfo.queryParameters = { dest_path: destPath };
    const item = await dataManager.callAction<undefined, FSItem>(actionInfo);
    return new FSItem(item);
  }

  /**
   * Create a new folder
   * @param typeid - Entity TypeId
   * @param path - Path for the new folder
   * @returns FSItem of the created folder
   * @throws Error if the folder creation fails or folder already exists
   */
  async mkdir(typeid: TypeId, path: string): Promise<FSItem> {
    const actionInfo = this.createFSAction(typeid, 'mkdir', path, 'POST');
    const item = await dataManager.callAction<undefined, FSItem>(actionInfo);
    return new FSItem(item);
  }

  /**
   * Write content directly to a file
   * @param typeid - Entity TypeId
   * @param path - File path to write to
   * @param content - String content to write
   * @returns FSItem of the created/updated file
   * @throws Error if the write fails
   */
  async writeFile(typeid: TypeId, path: string, content: string): Promise<FSItem> {
    const actionInfo = this.createFSAction(typeid, 'write', path, 'POST');
    actionInfo.bodyParameters = { content };
    const item = await dataManager.callAction<{ content: string }, FSItem>(actionInfo);
    return new FSItem(item);
  }

  /**
   * Open a file or folder in the OS default application
   * Only available in desktop and local environments
   * @param typeid - Entity TypeId
   * @param path - Path to the file or folder to open
   * @returns Success message
   * @throws Error if the open fails or environment doesn't support it
   */
  async open(typeid: TypeId, path: string): Promise<string> {
    const actionInfo = this.createFSAction(typeid, 'open', path, 'GET');
    return await dataManager.callAction<undefined, string>(actionInfo);
  }

  /**
   * Watch upload progress for a file
   * @param fsItemTypeid - TypeId of the FSItem being uploaded
   * @param callback - Callback invoked with progress percentage (0-100)
   * @returns Unsubscribe function
   */
  watchUploadProgress(fsItemTypeid: TypeId, callback: (progress: number) => void): () => void {
    return dataManager.subscribe<FSItem>(fsItemTypeid, (fsItem) => {
      if (fsItem && fsItem.upload_progress !== undefined) {
        callback(fsItem.upload_progress);
      }
    });
  }

  /**
   * Get file info (metadata) without downloading content
   * @param typeid - Entity TypeId
   * @param path - File path
   * @returns FSItem or null if not found
   */
  async getInfo(typeid: TypeId, path: string): Promise<FSItem | null> {
    try {
      const browseResult = await this.listDirectory(typeid, path);

      // If path is a directory with multiple items, return null
      if (browseResult.items.length > 1) {
        return null;
      }

      // Try to find the file in parent directory
      const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
      const filename = path.substring(path.lastIndexOf('/') + 1);

      if (!filename) {
        return null;
      }

      const parentBrowse = await this.listDirectory(typeid, parentPath);
      return parentBrowse.items.find((item) => item.name === filename) || null;
    } catch {
      return null;
    }
  }

  /**
   * Create a symbolic link
   * @param typeid - Entity TypeId
   * @param symlinkPath - Path where symlink will be created
   * @param targetPath - Path to target (VFS path or absolute)
   * @param relative - Create relative symlink (default: true)
   * @returns FSItem of created symlink
   */
  async createSymlink(
    typeid: TypeId,
    symlinkPath: string,
    targetPath: string,
    relative: boolean = true,
  ): Promise<FSItem> {
    if (symlinkPath.endsWith('/')) {
      throw new Error('Symlink path must include a filename');
    }

    const actionInfo = this.createFSAction(typeid, 'create_symlink', symlinkPath, 'POST');
    actionInfo.queryParameters = {
      target_path: targetPath,
      relative: relative.toString(),
    };

    const item = await dataManager.callAction<undefined, FSItem>(actionInfo);
    return new FSItem(item);
  }

  /**
   * Resolve a symbolic link to get its target
   * @param typeid - Entity TypeId
   * @param symlinkPath - Path to the symlink
   * @returns Object with target, validity, and original path
   */
  async resolveSymlink(typeid: TypeId, symlinkPath: string): Promise<SymlinkResolveResult> {
    const actionInfo = this.createFSAction(typeid, 'resolve_symlink', symlinkPath, 'GET');
    return await dataManager.callAction<undefined, SymlinkResolveResult>(actionInfo);
  }

  /**
   * Import an external folder or file by creating a symlink to it
   * This creates a symlink at the root of the entity's VFS pointing to an external path
   * @param typeid - Entity TypeId
   * @param externalPath - Absolute path to the external folder/file to import
   * @param linkName - Optional name for the symlink (defaults to basename of external path)
   * @returns FSItem of the created symlink
   */
  async importItem(typeid: TypeId, externalPath: string, linkName?: string): Promise<FSItem> {
    // Use empty path since symlink will be created at root
    const actionInfo = this.createFSAction(typeid, 'import_item', '', 'POST');
    actionInfo.queryParameters = {
      external_path: externalPath,
      ...(linkName && { link_name: linkName }),
    };

    const item = await dataManager.callAction<undefined, FSItem>(actionInfo);
    return new FSItem(item);
  }
}

// Export singleton instance
export const fsManager = FSManager.getInstance();

// Re-export FileUpload for convenience
export { FileUpload } from './FileUpload';

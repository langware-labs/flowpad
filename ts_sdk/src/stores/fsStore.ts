import { enableMapSet } from 'immer';
import { immer } from 'zustand/middleware/immer';
import { createStore } from 'zustand/vanilla';
import type { FileUpload, FSItem, TypeId } from '../index';
import { fsManager } from '../services/fsService';
import { dataContext } from '../FlowSync/context';

// Enable Map/Set support in Immer
enableMapSet();

// In-flight deduplication for listDirectory — prevents concurrent calls for the same path
// from firing multiple HTTP requests before the first response is cached.
const listDirInFlight = new Map<string, Promise<BrowseCache>>();

// ============================================================
// TYPES
// ============================================================

export interface ContentCache {
  content: string | Blob;
  fetchedAt: Date;
  isDirty: boolean; // Tracks if content has been modified locally
  originalPath?: string; // For tracking where content came from
}

export interface BrowseCache {
  items: FSItem[];
  path: string;
  totalSize: number;
  itemCount: number;
  fetchedAt: Date;
}

interface OperationState {
  isLoading: boolean;
  error: string | null;
}

export interface FSStoreState {
  // Cache data
  contentCache: Map<string, ContentCache>;
  existsCache: Map<string, boolean>;
  browseCache: Map<string, BrowseCache>;
  /** Monotonic invalidation revision per compute-node/path. Ancestor paths are
   * bumped with their changed child so folder-backed viewers can subscribe to
   * one subtree token without owning a second watcher. */
  pathRevisions: Map<string, number>;

  // Operation states (loading/error per operation)
  operations: Map<string, OperationState>;

  // ============================================================
  // QUERY METHODS
  // ============================================================

  /**
   * Check if file exists (cached)
   */
  exists: (typeid: TypeId, path: string) => Promise<boolean>;

  /**
   * Get download URL for a file
   */
  getDownloadUrl: (typeid: TypeId, path: string) => string;

  /**
   * Download file content (cached)
   */
  downloadFile: (typeid: TypeId, path: string, asBlob?: boolean) => Promise<string | Blob>;

  /**
   * Get content from cache only (no fetch)
   */
  getContentFromCache: (typeid: TypeId, path: string) => ContentCache | null;

  /** Current invalidation revision for a file or folder path. */
  getRevision: (typeid: TypeId, path: string) => number;

  /**
   * List directory contents (cached)
   */
  listDirectory: (typeid: TypeId, path: string) => Promise<BrowseCache>;

  // ============================================================
  // MUTATION METHODS
  // ============================================================

  /**
   * Upload files
   */
  uploadFiles: (
    typeid: TypeId,
    path: string,
    files: File[],
    onProgress?: (progress: number, filename: string) => void,
  ) => Promise<FileUpload[]>;

  /**
   * Delete file/directory
   */
  deleteFile: (typeid: TypeId, path: string) => Promise<void>;

  /**
   * Download directory as ZIP
   */
  downloadZip: (typeid: TypeId, path: string) => Promise<Blob>;

  /**
   * Upload and extract ZIP
   */
  uploadZip: (typeid: TypeId, path: string, zipFile: File) => Promise<string>;

  // ============================================================
  // DIRTY CONTENT MANAGEMENT
  // ============================================================

  /**
   * Set content externally (marks as dirty)
   */
  setContent: (path: string, content: string | Blob, markAsDirty?: boolean, typeid?: TypeId) => void;

  /**
   * Append content to existing content (for streaming multi-element writes)
   */
  appendContent: (path: string, chunk: string, markAsDirty?: boolean, typeid?: TypeId) => void;

  /**
   * Get all dirty items that need to be synced
   */
  getDirtyItems: () => Array<{ typeid: string; path: string; content: string | Blob }>;

  /**
   * Sync all dirty items to server
   */
  sync: (typeid: TypeId) => Promise<{ succeeded: string[]; failed: Array<{ path: string; error: string }> }>;

  /**
   * Mark content as clean (after successful upload)
   */
  markClean: (path: string, typeid?: TypeId) => void;

  /**
   * Write dirty content back to server for a specific file
   * @param path - File path to write back
   * @param typeid - Entity TypeId (optional, defaults to dataContext.projectTypeId)
   * @returns Promise that resolves when write is complete
   */
  writeBack: (path: string, typeid?: TypeId) => Promise<void>;

  // ============================================================
  // CACHE MANAGEMENT
  // ============================================================

  /**
   * Invalidate specific cache entry
   */
  invalidate: (typeid: TypeId, path: string, cacheType?: 'content' | 'exists' | 'browse' | 'all') => void;

  /**
   * Invalidate all caches for an entity
   */
  invalidateEntity: (typeid: TypeId) => void;

  /**
   * Clear all caches
   */
  clearCache: () => void;

  /**
   * Get operation state (loading/error)
   */
  getOperationState: (operationKey: string) => OperationState;
}

// ============================================================
// HELPERS
// ============================================================

function getCacheKey(typeid: TypeId, path: string): string {
  return `${typeid.toString()}:${normalizePath(path)}`;
}

function getRevisionKey(typeid: TypeId, path: string): string {
  const normalized = normalizePath(path).replace(/^\/+/, '') || '/';
  return `${typeid.toString()}:${normalized}`;
}

function normalizePath(path: string): string {
  // Treat empty, '.', and '/' all as root
  if (!path || path === '.') return '/';
  return path.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') return '/';
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : normalized.substring(0, lastSlash);
}

// ============================================================
// STORE IMPLEMENTATION
// ============================================================

export const fsStore = createStore<FSStoreState>()(
  immer((set, get) => ({
    // Initial state
    contentCache: new Map(),
    existsCache: new Map(),
    browseCache: new Map(),
    pathRevisions: new Map(),
    operations: new Map(),

    // ============================================================
    // QUERY METHODS
    // ============================================================

    exists: async (typeid: TypeId, path: string) => {
      const cacheKey = getCacheKey(typeid, path);

      // Check cache
      const cached = get().existsCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      try {
        const exists = await fsManager.exists(typeid, path);

        // Update cache
        set((state) => {
          state.existsCache.set(cacheKey, exists);
        });

        return exists;
      } catch (_error) {
        return false;
      }
    },

    getDownloadUrl: (typeid: TypeId, path: string) => {
      return fsManager.getDownloadUrl(typeid, path);
    },

    downloadFile: async (typeid: TypeId, path: string, asBlob = false) => {
      const cacheKey = `${getCacheKey(typeid, path)}:${asBlob ? 'blob' : 'text'}`;
      const operationKey = `download:${cacheKey}`;

      // Check cache (return even if dirty - dirty content is still valid cached content)
      const cached = get().contentCache.get(cacheKey);
      if (cached) {
        return cached.content;
      }

      set((state) => {
        state.operations.set(operationKey, { isLoading: true, error: null });
      });

      try {
        const content = await fsManager.download(typeid, path, { asBlob });

        set((state) => {
          state.contentCache.set(cacheKey, {
            content,
            fetchedAt: new Date(),
            isDirty: false,
            originalPath: path,
          });
          state.operations.set(operationKey, { isLoading: false, error: null });
        });

        return content;
      } catch (error: any) {
        set((state) => {
          state.operations.set(operationKey, {
            isLoading: false,
            error: error.message,
          });
        });
        throw error;
      }
    },

    getContentFromCache: (typeid: TypeId, path: string) => {
      const cacheKey = getCacheKey(typeid, path);
      // Try both text and blob variants
      return get().contentCache.get(`${cacheKey}:text`) || get().contentCache.get(`${cacheKey}:blob`) || null;
    },

    getRevision: (typeid: TypeId, path: string) =>
      get().pathRevisions.get(getRevisionKey(typeid, path)) ?? 0,

    listDirectory: async (typeid: TypeId, path: string) => {
      const cacheKey = getCacheKey(typeid, path);

      // Check cache first
      const cached = get().browseCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      // Deduplicate concurrent requests for the same path
      let pending = listDirInFlight.get(cacheKey);
      if (!pending) {
        // eslint-disable-next-line @typescript-eslint/no-shadow
        const fetchPromise: Promise<BrowseCache> = fsManager.listDirectory(typeid, path).then((result) => {
          const entry: BrowseCache = {
            items: [...result.items],
            path: result.path,
            totalSize: result.totalSize,
            itemCount: result.itemCount,
            fetchedAt: new Date(),
          };
          // Only commit to cache if we are still the active in-flight fetch.
          // If invalidate dropped us or a newer fetch replaced us, our result
          // is stale and would clobber the fresh data.
          if (listDirInFlight.get(cacheKey) === fetchPromise) {
            set((state) => {
              state.browseCache.set(cacheKey, entry as any);
            });
          }
          return entry;
        }).finally(() => {
          // Only clear our own slot, not a successor's
          if (listDirInFlight.get(cacheKey) === fetchPromise) {
            listDirInFlight.delete(cacheKey);
          }
        });
        listDirInFlight.set(cacheKey, fetchPromise);
        pending = fetchPromise;
      }

      return pending;
    },

    // ============================================================
    // MUTATION METHODS
    // ============================================================

    uploadFiles: async (typeid: TypeId, path: string, files: File[], onProgress) => {
      const operationKey = `upload:${getCacheKey(typeid, path)}`;

      set((state) => {
        state.operations.set(operationKey, { isLoading: true, error: null });
      });

      try {
        const fileUploads = await fsManager.uploadFiles(typeid, path, files, { onProgress });

        // Set up completion handlers
        const completionPromises = fileUploads.map((upload) =>
          upload.waitForCompletion().then(() => {
            // Invalidate exists and browse cache on completion
            get().invalidate(typeid, path, 'exists');
            get().invalidate(typeid, path, 'browse');
          }),
        );

        // When all complete, clear operation state
        Promise.all(completionPromises)
          .then(() => {
            set((state) => {
              state.operations.set(operationKey, { isLoading: false, error: null });
            });
          })
          .catch((error) => {
            set((state) => {
              state.operations.set(operationKey, {
                isLoading: false,
                error: error.message,
              });
            });
          });

        return fileUploads;
      } catch (error: any) {
        set((state) => {
          state.operations.set(operationKey, {
            isLoading: false,
            error: error.message,
          });
        });
        throw error;
      }
    },

    deleteFile: async (typeid: TypeId, path: string) => {
      const operationKey = `delete:${getCacheKey(typeid, path)}`;

      set((state) => {
        state.operations.set(operationKey, { isLoading: true, error: null });
      });

      try {
        await fsManager.delete(typeid, path);

        // Invalidate caches for the deleted path and parent directory
        get().invalidate(typeid, path, 'all');
        const parentPath = getParentPath(path);
        get().invalidate(typeid, parentPath, 'exists');
        get().invalidate(typeid, parentPath, 'browse');

        set((state) => {
          state.operations.set(operationKey, { isLoading: false, error: null });
        });
      } catch (error: any) {
        set((state) => {
          state.operations.set(operationKey, {
            isLoading: false,
            error: error.message,
          });
        });
        throw error;
      }
    },

    downloadZip: async (typeid: TypeId, path: string) => {
      return fsManager.downloadZip(typeid, path);
    },

    uploadZip: async (typeid: TypeId, path: string, zipFile: File) => {
      const result = await fsManager.uploadZip(typeid, path, zipFile);

      // Nuclear option: clear all caches for this entity
      get().invalidateEntity(typeid);

      return result;
    },

    // ============================================================
    // DIRTY CONTENT MANAGEMENT
    // ============================================================

    setContent: (path: string, content: string | Blob, markAsDirty: boolean = true, typeid?: TypeId) => {
      const resolvedTypeId = typeid ?? dataContext.projectTypeId;
      if (!resolvedTypeId) {
        throw new Error(
          '[FSStore] setContent: typeid is required. Either pass it as a parameter or ensure dataContext.projectTypeId is set.',
        );
      }

      const isBlob = content instanceof Blob;
      const cacheKey = `${getCacheKey(resolvedTypeId, path)}:${isBlob ? 'blob' : 'text'}`;

      // Check existing state
      const existing = get().contentCache.get(cacheKey);

      // If clearing dirty flag, log stack trace
      if (existing?.isDirty && !markAsDirty) {
        console.warn('[FSStore] ⚠️ setContent: Clearing dirty flag!', path);
      }

      set((state) => {
        state.contentCache.set(cacheKey, {
          content,
          fetchedAt: new Date(),
          isDirty: markAsDirty,
          originalPath: path,
        });
      });
    },

    appendContent: (path: string, chunk: string, markAsDirty: boolean = false, typeid?: TypeId) => {
      const resolvedTypeId = typeid ?? dataContext.projectTypeId;
      if (!resolvedTypeId) {
        throw new Error(
          '[FSStore] appendContent: typeid is required. Either pass it as a parameter or ensure dataContext.projectTypeId is set.',
        );
      }

      const cacheKey = `${getCacheKey(resolvedTypeId, path)}:text`;
      const existing = get().contentCache.get(cacheKey);
      const previousContent = existing?.content || '';

      // Only append to string content, not Blob
      if (previousContent instanceof Blob) {
        console.warn(`[FSStore] ⚠️ appendContent: Cannot append to Blob content for ${path}`);
        return;
      }

      const newContent = previousContent + chunk;

      set((state) => {
        state.contentCache.set(cacheKey, {
          content: newContent,
          fetchedAt: new Date(),
          isDirty: markAsDirty,
          originalPath: path,
        });
      });
    },

    getDirtyItems: () => {
      const dirtyItems: Array<{ typeid: string; path: string; content: string | Blob }> = [];

      get().contentCache.forEach((cache, key) => {
        if (cache.isDirty && cache.originalPath) {
          // Parse typeid from cache key (format: typeid:path:type)
          const [typeidStr] = key.split(':');
          dirtyItems.push({
            typeid: typeidStr,
            path: cache.originalPath,
            content: cache.content,
          });
        }
      });

      return dirtyItems;
    },

    sync: async (typeid: TypeId) => {
      const dirtyItems = get()
        .getDirtyItems()
        .filter((item) => item.typeid === typeid.toString());

      if (dirtyItems.length === 0) {
        return { succeeded: [], failed: [] };
      }

      const succeeded: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];

      // Upload each dirty item
      for (const item of dirtyItems) {
        try {
          // Convert content to File for upload
          const content = item.content;
          const filename = item.path.split('/').pop() || 'untitled';
          const file = content instanceof Blob ? new File([content], filename) : new File([content], filename);

          const parentPath = getParentPath(item.path);

          // Upload the file
          const uploads = await fsManager.uploadFiles(typeid, parentPath, [file]);
          await uploads[0].waitForCompletion();

          // Mark as clean
          get().markClean(item.path, typeid);

          succeeded.push(item.path);
        } catch (error: any) {
          failed.push({
            path: item.path,
            error: error.message || 'Upload failed',
          });
        }
      }

      // Invalidate exists and browse cache for parent directories
      const uniqueParents = new Set(dirtyItems.map((item) => getParentPath(item.path)));
      uniqueParents.forEach((parentPath) => {
        get().invalidate(typeid, parentPath, 'exists');
        get().invalidate(typeid, parentPath, 'browse');
      });

      return { succeeded, failed };
    },

    markClean: (path: string, typeid?: TypeId) => {
      const resolvedTypeId = typeid ?? dataContext.projectTypeId;
      if (!resolvedTypeId) {
        throw new Error(
          '[FSStore] markClean: typeid is required. Either pass it as a parameter or ensure dataContext.projectTypeId is set.',
        );
      }

      const textKey = `${getCacheKey(resolvedTypeId, path)}:text`;
      const blobKey = `${getCacheKey(resolvedTypeId, path)}:blob`;

      set((state) => {
        const textCache = state.contentCache.get(textKey);
        if (textCache) {
          textCache.isDirty = false;
        }

        const blobCache = state.contentCache.get(blobKey);
        if (blobCache) {
          blobCache.isDirty = false;
        }
      });
    },

    writeBack: async (path: string, typeid?: TypeId) => {
      const resolvedTypeId = typeid ?? dataContext.projectTypeId;
      if (!resolvedTypeId) {
        throw new Error(
          '[FSStore] writeBack: typeid is required. Either pass it as a parameter or ensure dataContext.projectTypeId is set.',
        );
      }

      const cached = get().getContentFromCache(resolvedTypeId, path);

      // Nothing to write back if not cached or not dirty
      if (!cached) {
        return;
      }

      if (!cached.isDirty) {
        return;
      }

      const operationKey = `writeBack:${getCacheKey(resolvedTypeId, path)}`;

      set((state) => {
        state.operations.set(operationKey, { isLoading: true, error: null });
      });

      try {
        // Convert content to File for upload
        const content = cached.content;
        const filename = path.split('/').pop() || 'untitled';
        const file = content instanceof Blob ? new File([content], filename) : new File([content], filename);

        const parentPath = getParentPath(path);

        // Upload the file via REST API
        const uploads = await fsManager.uploadFiles(resolvedTypeId, parentPath, [file]);
        await uploads[0].waitForCompletion();

        // Mark as clean on success
        get().markClean(path, resolvedTypeId);

        // Invalidate exists and browse cache for parent directory
        get().invalidate(resolvedTypeId, parentPath, 'exists');
        get().invalidate(resolvedTypeId, parentPath, 'browse');

        set((state) => {
          state.operations.set(operationKey, { isLoading: false, error: null });
        });
      } catch (error: any) {
        console.error('[FSStore] writeBack: Upload failed', path, (error as Error).message);

        set((state) => {
          state.operations.set(operationKey, {
            isLoading: false,
            error: error.message || 'Upload failed',
          });
        });

        throw error;
      }
    },

    // ============================================================
    // CACHE MANAGEMENT
    // ============================================================

    invalidate: (typeid: TypeId, path: string, cacheType = 'all') => {
      const cacheKey = getCacheKey(typeid, path);

      set((state) => {
        // One invalidation signal drives both exact-file and folder-backed
        // viewers. Bump the changed path and each ancestor through root.
        let revisionPath = normalizePath(path).replace(/^\/+/, '') || '/';
        while (true) {
          const revisionKey = getRevisionKey(typeid, revisionPath);
          state.pathRevisions.set(revisionKey, (state.pathRevisions.get(revisionKey) ?? 0) + 1);
          if (revisionPath === '/') break;
          revisionPath = getParentPath(revisionPath);
        }
        if (cacheType === 'content' || cacheType === 'all') {
          // A remote write may arrive while Monaco still owns an unsaved
          // buffer. Invalidating that dirty cache silently discards the user's
          // bytes. Clean entries are refetched; dirty entries remain the local
          // source until the user saves or discards them.
          const textKey = `${cacheKey}:text`;
          const blobKey = `${cacheKey}:blob`;
          if (!state.contentCache.get(textKey)?.isDirty) state.contentCache.delete(textKey);
          if (!state.contentCache.get(blobKey)?.isDirty) state.contentCache.delete(blobKey);
        }
        if (cacheType === 'exists' || cacheType === 'all') {
          state.existsCache.delete(cacheKey);
        }
        if (cacheType === 'browse' || cacheType === 'all') {
          state.browseCache.delete(cacheKey);
          // Drop any in-flight listDirectory promise too — otherwise the next
          // listDirectory call would dedup onto a request whose result was
          // captured before invalidation and overwrite the cache with stale data.
          listDirInFlight.delete(cacheKey);
        }
      });
    },

    invalidateEntity: (typeid: TypeId) => {
      const prefix = typeid.toString();

      set((state) => {
        const rootKey = getRevisionKey(typeid, '/');
        state.pathRevisions.set(rootKey, (state.pathRevisions.get(rootKey) ?? 0) + 1);
        // Remove all cache entries for this entity
        for (const [key, cache] of state.contentCache.entries()) {
          if (key.startsWith(prefix)) {
            if (!cache.isDirty) state.contentCache.delete(key);
          }
        }
        for (const key of state.existsCache.keys()) {
          if (key.startsWith(prefix)) {
            state.existsCache.delete(key);
          }
        }
        for (const key of state.browseCache.keys()) {
          if (key.startsWith(prefix)) {
            state.browseCache.delete(key);
          }
        }
      });
    },

    clearCache: () => {
      set((state) => {
        state.contentCache.clear();
        state.existsCache.clear();
        state.browseCache.clear();
        state.pathRevisions.clear();
        state.operations.clear();
      });
    },

    getOperationState: (operationKey: string) => {
      return get().operations.get(operationKey) || { isLoading: false, error: null };
    },
  })),
);

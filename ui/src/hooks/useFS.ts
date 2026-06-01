import type { BrowseCache, ContentCache } from '@sdk';
import { dataManager, fsManager, fsStore, type FSItem, type TypeId } from '@sdk';
import { useEffect } from 'react';
import { notify } from '@src/notifications';
import { useFSStore } from './useFSStore';

/**
 * useFS - React hook for file system operations
 *
 * Provides reactive access to file system operations backed by Zustand FSStore.
 * Automatically subscribes to WebSocket updates for real-time file changes.
 *
 * @param typeid - TypeId of the entity that owns the file system
 * @returns FS operations object with reactive selectors and mutation methods
 *
 * @example
 * ```tsx
 * function FileBrowser({ projectId }) {
 *   const fs = useFS(projectId);
 *   const browse = fs.browse('/');
 *
 *   const handleUpload = async (files: File[]) => {
 *     await fs.upload('/', files);
 *   };
 *
 *   return (
 *     <div>
 *       {browse?.items.map(item => (
 *         <FileRow key={item.name} file={item} />
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useFS(typeid?: TypeId) {
  // Subscribe to WebSocket updates for this entity
  useEffect(() => {
    if (!typeid) {
      return undefined;
    }

    // Check if dataManager and subscribe method are available
    if (!dataManager || typeof dataManager.subscribe !== 'function') {
      console.warn('dataManager.subscribe not available, WebSocket updates disabled');
      return undefined;
    }

    const unsubscribe = dataManager.subscribe<FSItem>(typeid, (updatedItem) => {
      // When a file changes, invalidate its cache
      if (updatedItem && updatedItem.relativePath) {
        fsStore.getState().invalidate(typeid, updatedItem.relativePath, 'all');

        // Also invalidate parent directory exists cache
        const parentPath = updatedItem.relativePath.substring(0, updatedItem.relativePath.lastIndexOf('/')) || '/';
        fsStore.getState().invalidate(typeid, parentPath, 'exists');
      }
    });

    return unsubscribe;
  }, [typeid]);

  // Use reactive Zustand selectors for content, exists, and browse
  const contentCache = useFSStore((state) => {
    return state.contentCache;
  });
  const existsCache = useFSStore((state) => state.existsCache);
  const browseCache = useFSStore((state) => state.browseCache);

  if (!typeid) {
    return null;
  }

  return {
    // ============================================================
    // REACTIVE QUERIES (via useSyncExternalStore through Zustand)
    // ============================================================

    /**
     * Get file content (reactive, cached)
     * Returns cached content or null if not yet fetched
     * Component will re-render when cache updates
     */
    content: (path: string): ContentCache | null => {
      const normalizedPath = path.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      const textKey = `${typeid.toString()}:${normalizedPath}:text`;
      const blobKey = `${typeid.toString()}:${normalizedPath}:blob`;

      const textResult = contentCache.get(textKey);
      const blobResult = contentCache.get(blobKey);

      // Check for text content first, then blob
      return textResult || blobResult || null;
    },

    /**
     * Get URL for a file
     * @param path - File path
     * @returns URL for the file
     */
    getDownloadUrl: (path: string): string => {
      return fsStore.getState().getDownloadUrl(typeid, path);
    },

    /**
     * Check if file exists (reactive, cached)
     * Returns cached existence check or null if not yet checked
     * Component will re-render when cache updates
     */
    exists: (path: string): boolean | null => {
      const cacheKey = `${typeid.toString()}:${path.replace(/\/+/g, '/').replace(/\/$/, '') || '/'}`;
      const cached = existsCache.get(cacheKey);
      return cached !== undefined ? cached : null;
    },

    /**
     * Get directory contents (reactive, cached)
     * Returns cached browse result or null if not yet fetched
     * Component will re-render when cache updates
     */
    browse: (path: string): BrowseCache | null => {
      const normalizedPath = path.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      const cacheKey = `${typeid.toString()}:${normalizedPath}`;
      return browseCache.get(cacheKey) || null;
    },

    // ============================================================
    // MUTATION METHODS (promise-based, trigger cache invalidation)
    // ============================================================

    /**
     * Upload files to a directory
     * @param path - Destination directory path
     * @param files - Files to upload
     * @param options - Upload options (onProgress callback, etc.)
     * @returns Array of FileUpload objects for tracking progress
     */
    upload: async (path: string, files: File[], options?: { onProgress?: (progress: number) => void }) => {
      return fsStore.getState().uploadFiles(typeid, path, files, options?.onProgress);
    },

    /**
     * Download file content
     * @param path - File path to download
     * @param asBlob - Return as Blob instead of string
     * @returns File content as string or Blob
     */
    download: async (path: string, asBlob = false) => {
      return fsStore.getState().downloadFile(typeid, path, asBlob);
    },

    /**
     * Download all files as ZIP archive
     * @param path - Directory path to download
     * @returns Blob containing ZIP data
     */
    downloadZip: async (path: string) => {
      return fsStore.getState().downloadZip(typeid, path);
    },

    /**
     * Delete file or directory
     * @param path - Path to delete
     */
    delete: async (path: string) => {
      return fsStore.getState().deleteFile(typeid, path);
    },

    /**
     * List directory contents (fetches and caches)
     * @param path - Directory path to list
     * @returns Browse result with items
     */
    listDirectory: async (path: string) => {
      return fsStore.getState().listDirectory(typeid, path);
    },

    /**
     * Check if file exists (fetches if not cached)
     * @param path - File path to check
     * @returns True if exists, false otherwise
     */
    checkExists: async (path: string) => {
      return fsStore.getState().exists(typeid, path);
    },

    /**
     * Fetch file metadata (fetches parent directory)
     * @param path - File path to fetch
     * @returns FSItem or null if not found
     */
    fetch: async (path: string): Promise<FSItem | null> => {
      const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
      const filename = path.substring(path.lastIndexOf('/') + 1);

      try {
        const browseResult = await fsManager.listDirectory(typeid, parentPath);
        return browseResult?.items.find((item: FSItem) => item.name === filename) || null;
      } catch {
        return null;
      }
    },

    // ============================================================
    // CACHE MANAGEMENT
    // ============================================================

    /**
     * Set file content in cache
     * @param path - File path
     * @param content - Content to cache
     * @param markAsDirty - Whether to mark as dirty (default: true for local edits, false for server content)
     */
    setContent: (path: string, content: string | Blob, markAsDirty: boolean = true) => {
      fsStore.getState().setContent(path, content, markAsDirty, typeid);
    },

    /**
     * Mark file as clean (after successful save)
     * @param path - File path
     */
    markClean: (path: string) => {
      fsStore.getState().markClean(path, typeid);
    },

    /**
     * Write dirty content back to server
     * @param path - File path to write back
     * @returns Promise that resolves when write is complete
     */
    writeBack: async (path: string) => {
      return fsStore.getState().writeBack(path, typeid);
    },

    /**
     * Invalidate specific cache
     * @param path - File/directory path
     * @param cacheType - Type of cache to invalidate (content, exists, browse, all)
     */
    invalidate: (path: string, cacheType?: 'content' | 'exists' | 'browse' | 'all') => {
      fsStore.getState().invalidate(typeid, path, cacheType);
    },

    /**
     * Re-read a file's content from the server, discarding the cached copy.
     * Surfaces a toast warning if the discarded cache had unsaved edits, so
     * the user isn't silently losing work.
     */
    refetch: async (path: string, asBlob = false) => {
      const store = fsStore.getState();
      if (store.getContentFromCache(typeid, path)?.isDirty) {
        notify.warning({ title: 'Discarded unsaved edits', message: path });
      }
      store.invalidate(typeid, path, 'content');
      return store.downloadFile(typeid, path, asBlob);
    },

    /**
     * Invalidate all caches for this entity
     */
    invalidateAll: () => {
      fsStore.getState().invalidateEntity(typeid);
    },

    /**
     * Clear all caches (global)
     */
    clearCache: () => {
      fsStore.getState().clearCache();
    },
  };
}

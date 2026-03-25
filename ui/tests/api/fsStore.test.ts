import { Workspace, TypeId, fsStore, fsManager } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

/**
 * FSStore Cache Tests
 * Tests caching behavior, dirty tracking, and sync functionality
 * Does NOT duplicate basic FS operations (covered in fsService.test.ts)
 *
 * Note: Tests that need files on the server use fsManager.writeFile() instead of
 * store.uploadFiles() because jsdom's FormData does not properly serialize
 * multipart/form-data over XMLHttpRequest.
 *
 * Sync tests that depend on fsManager.uploadFiles() internally are skipped.
 */
describe('FSStore Cache Tests', () => {
  const signupInfo = getTestSignupInfo();
  let testWorkspace: Workspace;
  let testTypeid: TypeId;
  let store: ReturnType<typeof fsStore.getState>;

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);

    // Create test workspace
    testWorkspace = new Workspace({ name: `FSStore Test ${Date.now()}` });
    await testWorkspace.save();
    testTypeid = testWorkspace.typeId;

    // Get fresh store instance
    store = fsStore.getState();
    store.clearCache();

    console.log('Created test workspace:', testTypeid);
  });

  afterEach(async () => {
    // Clean up
    if (testWorkspace) {
      try {
        await testWorkspace.delete();
      } catch (e) {
        console.warn('Failed to delete test workspace:', e);
      }
    }

    // Clear store cache
    fsStore.getState().clearCache();
  });

  // ============================================================
  // CACHE TESTS
  // ============================================================

  describe('Cache Behavior', () => {
    it('should cache browse results and return from cache on second call', async () => {
      // First call - should fetch from backend
      const result1 = await store.listDirectory(testTypeid, '/');
      expect(result1).toBeTruthy();
      expect(result1.fetchedAt).toBeInstanceOf(Date);

      const fetchedAt1 = result1.fetchedAt;

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second call - should return from cache (same fetchedAt timestamp)
      const result2 = await store.listDirectory(testTypeid, '/');
      expect(result2.fetchedAt).toBe(fetchedAt1);
      expect(result2).toBe(result1); // Same object reference
    }, 10000);

    it('should cache content and return from cache on second call', async () => {
      // Create a test file using writeFile (avoids FormData/jsdom issue)
      await fsManager.writeFile(testTypeid, 'cache_test.txt', 'Test content for cache');

      // First download - fetch from backend
      const content1 = await store.downloadFile(testTypeid, 'cache_test.txt');
      expect(content1).toBeTruthy();

      // Get the cached entry
      const cachedEntry1 = store.getContentFromCache(testTypeid, 'cache_test.txt');
      expect(cachedEntry1).toBeTruthy();
      expect(cachedEntry1?.isDirty).toBe(false);
      const fetchedAt1 = cachedEntry1!.fetchedAt;

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second download - should return from cache
      const content2 = await store.downloadFile(testTypeid, 'cache_test.txt');
      expect(content2).toBe(content1);

      const cachedEntry2 = store.getContentFromCache(testTypeid, 'cache_test.txt');
      expect(cachedEntry2?.fetchedAt).toBe(fetchedAt1); // Same timestamp = from cache
    }, 15000);

    it('should cache exists checks', async () => {
      // Create a file using writeFile
      await fsManager.writeFile(testTypeid, 'exists_cache.txt', 'Exists test');

      // First exists check - fetch
      const exists1 = await store.exists(testTypeid, 'exists_cache.txt');
      expect(exists1).toBe(true);

      // Second exists check - from cache (should be instant)
      const start = Date.now();
      const exists2 = await store.exists(testTypeid, 'exists_cache.txt');
      const duration = Date.now() - start;

      expect(exists2).toBe(true);
      expect(duration).toBeLessThan(10); // Should be very fast (from cache)
    }, 15000);
  });

  // ============================================================
  // EXTERNAL INVALIDATION TESTS
  // ============================================================

  describe('External Invalidation', () => {
    it('should allow external invalidation of browse cache', async () => {
      // Populate cache
      const result1 = await store.listDirectory(testTypeid, '/');
      expect(result1.itemCount).toBe(0);

      // Invalidate browse cache
      store.invalidate(testTypeid, '/', 'browse');

      // Create a file using writeFile
      await fsManager.writeFile(testTypeid, 'external.txt', 'External content');

      // Next browse should fetch fresh data (not from cache)
      const result2 = await store.listDirectory(testTypeid, '/');
      expect(result2.itemCount).toBeGreaterThan(0);
      expect(result2.fetchedAt).not.toBe(result1.fetchedAt);
    }, 15000);

    it('should allow external invalidation of content cache', async () => {
      // Create and download file
      await fsManager.writeFile(testTypeid, 'invalidate_content.txt', 'Original content');

      const content1 = await store.downloadFile(testTypeid, 'invalidate_content.txt');
      expect(content1).toContain('Original');

      // Verify it's cached
      const cached1 = store.getContentFromCache(testTypeid, 'invalidate_content.txt');
      expect(cached1).toBeTruthy();

      // Invalidate content cache
      store.invalidate(testTypeid, 'invalidate_content.txt', 'content');

      // Verify cache is cleared
      const cached2 = store.getContentFromCache(testTypeid, 'invalidate_content.txt');
      expect(cached2).toBeNull();
    }, 15000);

    it('should allow invalidating all caches for a file', async () => {
      // Create file
      await fsManager.writeFile(testTypeid, 'invalidate_all.txt', 'Test all invalidation');

      // Populate all caches
      await store.listDirectory(testTypeid, '/');
      await store.downloadFile(testTypeid, 'invalidate_all.txt');
      await store.exists(testTypeid, 'invalidate_all.txt');

      // Verify caches exist
      expect(store.getContentFromCache(testTypeid, 'invalidate_all.txt')).toBeTruthy();

      // Invalidate all
      store.invalidate(testTypeid, 'invalidate_all.txt', 'all');

      // Verify all caches cleared
      expect(store.getContentFromCache(testTypeid, 'invalidate_all.txt')).toBeNull();
    }, 15000);

    it('should invalidate entire entity cache', async () => {
      // Create multiple files using writeFile
      await fsManager.writeFile(testTypeid, 'file1.txt', 'File 1');
      await fsManager.writeFile(testTypeid, 'file2.txt', 'File 2');

      // Populate caches
      await store.listDirectory(testTypeid, '/');
      await store.downloadFile(testTypeid, 'file1.txt');
      await store.downloadFile(testTypeid, 'file2.txt');

      // Verify caches exist
      expect(store.getContentFromCache(testTypeid, 'file1.txt')).toBeTruthy();
      expect(store.getContentFromCache(testTypeid, 'file2.txt')).toBeTruthy();

      // Invalidate entire entity
      store.invalidateEntity(testTypeid);

      // Verify all caches cleared
      expect(store.getContentFromCache(testTypeid, 'file1.txt')).toBeNull();
      expect(store.getContentFromCache(testTypeid, 'file2.txt')).toBeNull();
    }, 15000);
  });

  // ============================================================
  // DIRTY TRACKING TESTS
  // ============================================================

  describe('Dirty Content Tracking', () => {
    it('should mark content as dirty when set externally', async () => {
      // Create a file using writeFile
      await fsManager.writeFile(testTypeid, 'dirty_test.txt', 'Original content');

      // Download to populate cache
      await store.downloadFile(testTypeid, 'dirty_test.txt');

      // Verify not dirty initially
      const cached1 = store.getContentFromCache(testTypeid, 'dirty_test.txt');
      expect(cached1?.isDirty).toBe(false);

      // Set content externally
      store.setContent('dirty_test.txt', 'Modified content', true, testTypeid);

      // Verify marked as dirty
      const cached2 = store.getContentFromCache(testTypeid, 'dirty_test.txt');
      expect(cached2?.isDirty).toBe(true);
      expect(cached2?.content).toBe('Modified content');
    }, 15000);

    it('should track multiple dirty items', async () => {
      // Set content for multiple files (some don't exist yet)
      store.setContent('dirty1.txt', 'Content 1', true, testTypeid);
      store.setContent('dirty2.txt', 'Content 2', true, testTypeid);
      store.setContent('dirty3.txt', 'Content 3', true, testTypeid);

      // Get dirty items
      const dirtyItems = store.getDirtyItems();

      expect(dirtyItems.length).toBe(3);
      expect(dirtyItems.map((item) => item.path)).toContain('dirty1.txt');
      expect(dirtyItems.map((item) => item.path)).toContain('dirty2.txt');
      expect(dirtyItems.map((item) => item.path)).toContain('dirty3.txt');
    }, 10000);

    it('should mark content as clean after explicit markClean', async () => {
      // Set dirty content
      store.setContent('clean_test.txt', 'Dirty content', true, testTypeid);

      // Verify dirty
      let cached = store.getContentFromCache(testTypeid, 'clean_test.txt');
      expect(cached?.isDirty).toBe(true);

      // Mark clean
      store.markClean('clean_test.txt', testTypeid);

      // Verify clean
      cached = store.getContentFromCache(testTypeid, 'clean_test.txt');
      expect(cached?.isDirty).toBe(false);
    }, 10000);
  });

  // ============================================================
  // SYNC TESTS
  // SKIPPED: store.sync() internally calls fsManager.uploadFiles() which uses
  // FormData. jsdom's FormData does not properly serialize multipart/form-data.
  // ============================================================

  describe('Sync Functionality (requires real browser FormData)', () => {
    it('should sync dirty items to server', async () => {
      // Set dirty content for new files
      store.setContent('sync1.txt', 'Sync content 1', true, testTypeid);
      store.setContent('sync2.txt', 'Sync content 2', true, testTypeid);

      // Verify dirty
      const dirtyBefore = store.getDirtyItems();
      expect(dirtyBefore.length).toBe(2);

      // Sync
      const result = await store.sync(testTypeid);

      console.log('Sync result:', result);

      expect(result.succeeded.length).toBe(2);
      expect(result.failed.length).toBe(0);

      // Verify marked as clean
      const dirtyAfter = store.getDirtyItems();
      expect(dirtyAfter.length).toBe(0);

      // Verify files exist on server
      const browseResult = await store.listDirectory(testTypeid, '/');
      const fileNames = browseResult.items.map((item) => item.name);
      expect(fileNames).toContain('sync1.txt');
      expect(fileNames).toContain('sync2.txt');
    }, 15000);

    it('should handle partial sync failures gracefully', async () => {
      // Set one valid dirty item
      store.setContent('valid_sync.txt', 'Valid content', true, testTypeid);

      const result = await store.sync(testTypeid);

      // At least one should succeed
      expect(result.succeeded.length).toBeGreaterThan(0);

      console.log('Partial sync result:', result);
    }, 15000);

    it('should return empty result when no dirty items exist', async () => {
      // Sync with no dirty items
      const result = await store.sync(testTypeid);

      expect(result.succeeded.length).toBe(0);
      expect(result.failed.length).toBe(0);
    }, 10000);

    it('should invalidate browse cache after successful sync', async () => {
      // Get initial browse result
      const before = await store.listDirectory(testTypeid, '/');
      const initialCount = before.itemCount;

      // Set dirty content
      store.setContent('sync_invalidate.txt', 'Content that should invalidate cache', true, testTypeid);

      // Sync
      await store.sync(testTypeid);

      // Browse should show new file (cache invalidated)
      const after = await store.listDirectory(testTypeid, '/');
      expect(after.itemCount).toBeGreaterThan(initialCount);
      expect(after.items.some((item) => item.name === 'sync_invalidate.txt')).toBe(true);
    }, 15000);
  });

  // ============================================================
  // CACHE VALIDITY TESTS
  // ============================================================

  describe('Cache Validity', () => {
    it('should maintain cache validity after mutations', async () => {
      // Create initial file using writeFile
      await fsManager.writeFile(testTypeid, 'validity1.txt', 'Initial');

      // Browse (populate cache)
      const browse1 = await store.listDirectory(testTypeid, '/');
      expect(browse1.itemCount).toBe(1);

      // Invalidate browse cache so next listing is fresh
      store.invalidate(testTypeid, '/', 'browse');

      // Create another file using writeFile
      await fsManager.writeFile(testTypeid, 'validity2.txt', 'Second');

      // Browse again - should show updated list
      const browse2 = await store.listDirectory(testTypeid, '/');
      expect(browse2.itemCount).toBe(2);
      expect(browse2.items.map((i) => i.name)).toContain('validity1.txt');
      expect(browse2.items.map((i) => i.name)).toContain('validity2.txt');
    }, 15000);

    it('should invalidate parent directory cache on delete', async () => {
      // Create file using writeFile
      await fsManager.writeFile(testTypeid, 'delete_validity.txt', 'Delete validity');

      // Browse (populate cache)
      const browse1 = await store.listDirectory(testTypeid, '/');
      expect(browse1.itemCount).toBe(1);

      // Delete file via store (this should invalidate caches)
      await store.deleteFile(testTypeid, 'delete_validity.txt');

      // Browse again - should show empty directory
      const browse2 = await store.listDirectory(testTypeid, '/');
      expect(browse2.itemCount).toBe(0);
    }, 15000);

    it('should not return stale content for dirty files', async () => {
      // Create file using writeFile
      await fsManager.writeFile(testTypeid, 'stale_test.txt', 'Original');

      // Download (populate cache)
      const content1 = await store.downloadFile(testTypeid, 'stale_test.txt');
      expect(content1).toContain('Original');

      // Modify content externally (mark as dirty)
      store.setContent('stale_test.txt', 'Modified locally', true, testTypeid);

      // Get from cache - should return modified content
      const cached = store.getContentFromCache(testTypeid, 'stale_test.txt');
      expect(cached?.content).toBe('Modified locally');
      expect(cached?.isDirty).toBe(true);

      // downloadFile should still return cached content (even if dirty)
      // This is expected behavior - dirty content is still valid cached content
      const content2 = await store.downloadFile(testTypeid, 'stale_test.txt');
      expect(content2).toBe('Modified locally');
    }, 15000);
  });
});

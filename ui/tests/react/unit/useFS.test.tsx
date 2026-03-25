import { apiStats, clearStats, fsStore, TypeId, Workspace } from '@sdk';
import { useFS } from '@src/hooks/useFS';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../../utils/test-utils';

/**
 * useFS Hook Tests
 * Tests React hook integration with FSStore and cache behavior verification using apiStats
 */
describe('useFS Hook Tests', () => {
  const signupInfo = getTestSignupInfo();
  let testWorkspace: Workspace;
  let testTypeid: TypeId;

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);

    // Create test workspace
    testWorkspace = new Workspace({ name: `useFS Test ${Date.now()}` });
    await testWorkspace.save();
    testTypeid = testWorkspace.typeId;

    // Clear caches and stats
    fsStore.getState().clearCache();

    console.log('✓ Created test workspace:', testTypeid);
  }, 10000);

  afterEach(async () => {
    // Clean up
    if (testWorkspace) {
      try {
        await testWorkspace.delete();
      } catch (e) {
        console.warn('Failed to delete test workspace:', e);
      }
    }

    fsStore.getState().clearCache();
  }, 10000);

  // ============================================================
  // BASIC HOOK USAGE
  // ============================================================

  describe('Basic Hook Usage', () => {
    it('should return fs operations object', () => {
      const { result } = renderHook(() => useFS(testTypeid));

      expect(result.current).toBeTruthy();
      expect(typeof result.current.content).toBe('function');
      expect(typeof result.current.upload).toBe('function');
      expect(typeof result.current.download).toBe('function');
      expect(typeof result.current.delete).toBe('function');
      expect(typeof result.current.listDirectory).toBe('function');
    });

    it('should return null for uncached data', () => {
      const { result } = renderHook(() => useFS(testTypeid));

      const contentData = result.current.content('/file.txt');
      const existsData = result.current.exists('/file.txt');

      expect(contentData).toBeNull();
      expect(existsData).toBeNull();
    });
  });

  // ============================================================
  // CACHE BEHAVIOR & API STATS
  // ============================================================

  describe('Cache Behavior', () => {
    it('should fetch directory listing via listDirectory', async () => {
      const { result } = renderHook(() => useFS(testTypeid));

      const statsBefore = apiStats.clone();

      // First call - should hit API
      let browseResult: any;
      await act(async () => {
        browseResult = await result.current.listDirectory('/');
      });

      const statsAfterFirst = apiStats.clone();
      const deltaFirst = statsAfterFirst.delta(statsBefore);

      // Should have made 1 GET request
      expect(deltaFirst.successfulGET).toBe(1);
      expect(deltaFirst.totalRequests).toBe(1);
      expect(browseResult).toBeTruthy();
      expect(browseResult.items).toBeDefined();

      console.log('✓ listDirectory fetches directory listing');
    }, 15000);

    it('should cache content and avoid redundant downloads', async () => {
      const { result } = renderHook(() => useFS(testTypeid));

      // Upload a test file first
      const testFile = new File(['Test content'], 'cache_test.txt', { type: 'text/plain' });
      await act(async () => {
        const uploads = await result.current.upload('/', [testFile]);
        await uploads[0].waitForCompletion();
      });

      // Clear stats
      clearStats();
      const statsBefore = apiStats.clone();

      // First download - should hit API
      await act(async () => {
        await result.current.download('cache_test.txt');
      });

      const statsAfterFirst = apiStats.clone();
      const deltaFirst = statsAfterFirst.delta(statsBefore);
      expect(deltaFirst.successfulGET).toBe(1);

      // Second download - should use cache
      await act(async () => {
        await result.current.download('cache_test.txt');
      });

      const statsAfterSecond = apiStats.clone();
      const deltaSecond = statsAfterSecond.delta(statsAfterFirst);

      // No additional API calls
      expect(deltaSecond.successfulGET).toBe(0);

      console.log('✓ Content cache working: First download made 1 request, second used cache');
    }, 15000);
  });

  // ============================================================
  // REACTIVE UPDATES
  // ============================================================

  describe('Reactive Updates', () => {
    it('should update content cache when file is uploaded', async () => {
      const { result } = renderHook(() => useFS(testTypeid));

      // Upload a file
      const testFile = new File(['Test content'], 'reactive_test.txt', { type: 'text/plain' });

      await act(async () => {
        const uploads = await result.current.upload('/', [testFile]);
        await uploads[0].waitForCompletion();
      });

      // Download to populate cache
      await act(async () => {
        await result.current.download('reactive_test.txt');
      });

      // Content should now be cached
      const cachedContent = result.current.content('reactive_test.txt');
      expect(cachedContent).toBeTruthy();
      expect(cachedContent?.content).toContain('Test content');

      console.log('✓ Content cache updated after upload and download');
    }, 15000);
  });

  // ============================================================
  // FILE OPERATIONS
  // ============================================================

  describe('File Operations', () => {
    it('should upload file and list directory', async () => {
      const { result } = renderHook(() => useFS(testTypeid));

      const testFile = new File(['Upload test content'], 'upload_test.txt', { type: 'text/plain' });

      await act(async () => {
        const uploads = await result.current.upload('/', [testFile]);
        expect(uploads.length).toBe(1);
        await uploads[0].waitForCompletion();
      });

      // Fetch updated listing
      let listing: any;
      await act(async () => {
        listing = await result.current.listDirectory('/');
      });

      expect(listing?.items.some((item: any) => item.name === 'upload_test.txt')).toBe(true);
    }, 15000);

    it('should download file content', async () => {
      const { result } = renderHook(() => useFS(testTypeid));

      const content = 'Download test content';
      const testFile = new File([content], 'download_test.txt', { type: 'text/plain' });

      await act(async () => {
        const uploads = await result.current.upload('/', [testFile]);
        await uploads[0].waitForCompletion();
      });

      const downloaded = await act(async () => {
        return await result.current.download('download_test.txt');
      });

      expect(downloaded).toContain(content);
    }, 15000);

    it('should delete file and verify removal', async () => {
      const { result } = renderHook(() => useFS(testTypeid));

      const testFile = new File(['Delete test'], 'delete_test.txt', { type: 'text/plain' });

      await act(async () => {
        const uploads = await result.current.upload('/', [testFile]);
        await uploads[0].waitForCompletion();
      });

      // Verify file exists
      let listing: any;
      await act(async () => {
        listing = await result.current.listDirectory('/');
      });

      expect(listing?.items.some((item: any) => item.name === 'delete_test.txt')).toBe(true);

      // Delete file
      await act(async () => {
        await result.current.delete('delete_test.txt');
      });

      // Refetch and verify removal
      await act(async () => {
        listing = await result.current.listDirectory('/');
      });

      expect(listing?.items.some((item: any) => item.name === 'delete_test.txt')).toBe(false);
    }, 15000);
  });

  // ============================================================
  // BROWSE CACHE SYNCHRONIZATION
  // ============================================================

  describe('Browse Cache Synchronization', () => {
    it('browse cache updates after upload and invalidation', async () => {
      const { result } = renderHook(() => useFS(testTypeid));

      // Fetch the directory listing (populates shared cache)
      await act(async () => {
        await result.current.listDirectory('/');
      });

      // Verify initial state via browse() reactive getter
      const initialBrowse = result.current.browse('/');
      expect(initialBrowse).toBeTruthy();
      const initialCount = initialBrowse?.items.length ?? 0;

      // Upload a file
      const testFile = new File(['Sync test content'], 'sync_test.txt', { type: 'text/plain' });
      await act(async () => {
        const uploads = await result.current.upload('/', [testFile]);
        await uploads[0].waitForCompletion();
      });

      // Invalidate and refetch (simulates what SimpleFileManager does)
      await act(async () => {
        result.current.invalidate('/', 'browse');
        await result.current.listDirectory('/');
      });

      // Verify browse() returns updated data from shared cache
      const updatedBrowse = result.current.browse('/');
      expect(updatedBrowse?.items.length).toBe(initialCount + 1);
      expect(updatedBrowse?.items.some((item: any) => item.name === 'sync_test.txt')).toBe(true);

      // Verify fsStore browseCache is updated (other components would read this)
      const cacheKey = `${testTypeid.toString()}:/`;
      const storeCache = fsStore.getState().browseCache.get(cacheKey);
      expect(storeCache?.items.some((item: any) => item.name === 'sync_test.txt')).toBe(true);

      console.log('✓ Browse cache updates after upload and invalidation');
    }, 15000);

    it('normalizes root path variants (/ and .) to same cache key', async () => {
      const { result } = renderHook(() => useFS(testTypeid));

      // Fetch with '/' path
      await act(async () => {
        await result.current.listDirectory('/');
      });

      // browse('/') should return cached data
      const browseSlash = result.current.browse('/');
      expect(browseSlash).toBeTruthy();
      expect(browseSlash?.items).toBeDefined();

      // Verify cache key normalization by checking stats
      const statsBefore = apiStats.clone();

      // Fetching again with '/' should use cache (no API call)
      await act(async () => {
        await result.current.listDirectory('/');
      });

      const statsAfter = apiStats.clone();
      const delta = statsAfter.delta(statsBefore);

      // No additional API call because cache was used
      expect(delta.successfulGET).toBe(0);

      console.log('✓ Root path normalization working correctly');
    }, 15000);

    it('listDirectory with . path uses same cache as / path', async () => {
      const { result } = renderHook(() => useFS(testTypeid));

      // First fetch with '/' - this will hit the API
      await act(async () => {
        await result.current.listDirectory('/');
      });

      const statsBefore = apiStats.clone();

      // Fetch with '.' - should use cache because '.' normalizes to '/'
      await act(async () => {
        await result.current.listDirectory('.');
      });

      const statsAfter = apiStats.clone();
      const delta = statsAfter.delta(statsBefore);

      // No additional API call because '.' normalized to '/' and used cache
      expect(delta.successfulGET).toBe(0);

      console.log('✓ Path . normalizes to / for cache lookup');
    }, 15000);
  });

  // ============================================================
  // CACHE INVALIDATION
  // ============================================================

  describe('Cache Invalidation', () => {
    it('should manually invalidate content cache', async () => {
      const { result } = renderHook(() => useFS(testTypeid));

      // Upload and download to cache content
      const testFile = new File(['Test content'], 'invalidate_test.txt', { type: 'text/plain' });
      await act(async () => {
        const uploads = await result.current.upload('/', [testFile]);
        await uploads[0].waitForCompletion();
        await result.current.download('invalidate_test.txt');
      });

      expect(result.current.content('invalidate_test.txt')).toBeTruthy();

      // Invalidate content cache
      act(() => {
        result.current.invalidate('invalidate_test.txt', 'content');
      });

      // Cache should be cleared
      expect(result.current.content('invalidate_test.txt')).toBeNull();
    }, 15000);

    it('should invalidate all caches for entity', async () => {
      const { result } = renderHook(() => useFS(testTypeid));

      // Upload and cache content
      const testFile = new File(['Test'], 'invalidate_all_test.txt', { type: 'text/plain' });
      await act(async () => {
        const uploads = await result.current.upload('/', [testFile]);
        await uploads[0].waitForCompletion();
        await result.current.download('invalidate_all_test.txt');
      });

      expect(result.current.content('invalidate_all_test.txt')).toBeTruthy();

      // Invalidate all
      act(() => {
        result.current.invalidateAll();
      });

      expect(result.current.content('invalidate_all_test.txt')).toBeNull();
    }, 15000);
  });

  // ============================================================
  // API STATS VERIFICATION
  // ============================================================

  describe('API Stats Verification', () => {
    it('should track API calls correctly', async () => {
      const { result } = renderHook(() => useFS(testTypeid));
      const initialStats = apiStats.clone();

      // Upload (POST)
      const testFile = new File(['Stats test'], 'stats_test.txt', { type: 'text/plain' });
      await act(async () => {
        const uploads = await result.current.upload('/', [testFile]);
        await uploads[0].waitForCompletion();
      });

      const afterUpload = apiStats.clone();
      const uploadDelta = afterUpload.delta(initialStats);
      expect(uploadDelta.successfulPOST).toBeGreaterThan(0);

      // Browse (GET)
      await act(async () => {
        await result.current.listDirectory('/');
      });

      const afterBrowse = apiStats.clone();
      const browseDelta = afterBrowse.delta(afterUpload);
      expect(browseDelta.successfulGET).toBe(1);

      // Download (GET)
      await act(async () => {
        await result.current.download('stats_test.txt');
      });

      const afterDownload = apiStats.clone();
      const downloadDelta = afterDownload.delta(afterBrowse);
      expect(downloadDelta.successfulGET).toBe(1);

      // Delete (DELETE)
      await act(async () => {
        await result.current.delete('stats_test.txt');
      });

      const afterDelete = apiStats.clone();
      const deleteDelta = afterDelete.delta(afterDownload);
      expect(deleteDelta.successfulDELETE).toBe(1);

      console.log('✓ API stats correctly tracked all operations');
    }, 15000);
  });
});

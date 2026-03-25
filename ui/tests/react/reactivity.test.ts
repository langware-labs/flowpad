import {
  apiClient,
  ConnectionManager,
  dataManager,
  GRAPH_API_PREFIX,
  IEntity,
  Bookmark,
  QueryRequest,
} from '@sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, getTestSignupInfo, noop } from '../utils/test-utils';

async function waitForConnection(manager: ConnectionManager) {
  await vi.waitFor(
    () => {
      if (!manager.connected) throw new Error('Cannot connect to ws server');
      console.log('Connected to ws server');
    },
    {
      timeout: 5000,
      interval: 500,
    },
  );
  expect(manager.connected).toBe(true);
}

describe('reactivity bug scenario', () => {
  const info = getTestSignupInfo();

  beforeAll(async () => {
    noop();
  });

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
  }, 10000);

  afterAll(async () => {});

  it('test reactivity bug - empty watchedQueries results on delete DataOp', async () => {
    // Step 1: Setup websocket connection (mimicking UI startup)
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Step 2: Setup watchQuery for "all pages" (mimicking EntityListElement behavior)
    // This is exactly how EntityListElement.ts:131 registers the query
    let queryCallbackInvoked = 0;
    let latestQueryResults: Bookmark[] = [];

    const request = new QueryRequest({
      type: "bookmark", // type - like EntityListElement
      query: null, // query - null means "all pages"
      scope: [], // scope - empty scope means global
      callback: (updatedEntities) => {
        queryCallbackInvoked++;
        latestQueryResults = updatedEntities;
        console.log(`Query callback #${queryCallbackInvoked} - received ${updatedEntities.length} pages`);
      },
      name: 'reactivity test - empty watchedQueries results on delete DataOp',
    });
    const unwatchQuery = await dataManager.watchQuery<Bookmark>(request);
    let cachedQueryResults = dataManager.getCachedQueryResults<Bookmark>('bookmark', null, []);
    console.log('Cached query results', (cachedQueryResults || []).length);

    // Verify initial query callback
    expect(queryCallbackInvoked).toBeGreaterThan(0);
    console.log(`Initial pages count: ${latestQueryResults.length}`);

    // Step 3: Create new page (mimicking UI "create page" action)
    // This should trigger query refresh and UI refresh
    const newPage = new Bookmark({
      title: `test-reactivity-bug-${Date.now()}`,
    });

    const initialCallbackCount = queryCallbackInvoked;
    await newPage.save();
    console.log('Bookmark created, waiting for query refresh...');
    cachedQueryResults = dataManager.getCachedQueryResults<Bookmark>('bookmark', null, []);
    console.log('Cached query results after save', (cachedQueryResults || []).length);
    // Wait for query callback to be triggered by create operation
    await vi.waitFor(
      () => {
        if (queryCallbackInvoked <= initialCallbackCount) {
          throw new Error('Query callback not triggered after page creation');
        }
      },
      { timeout: 5000, interval: 100 },
    );

    const afterCreateCount = queryCallbackInvoked;
    const pagesAfterCreate = latestQueryResults.length;
    console.log(`After create: ${pagesAfterCreate} pages, callback count: ${afterCreateCount}`);

    // Verify the new page appears in query results
    const createdPageInResults: Bookmark | undefined = latestQueryResults.find((p) => p.id === newPage.id);
    expect(createdPageInResults).toBeDefined();
    console.log(`Created page found in query results: ${createdPageInResults?.title}`);
    cachedQueryResults = dataManager.getCachedQueryResults<Bookmark>('bookmark', null, []);
    console.log('Cached query results after create op', (cachedQueryResults || []).length);

    console.log('Deleting page...');
    const beforeDeleteCount = queryCallbackInvoked;
    await createdPageInResults!.delete();
    cachedQueryResults = dataManager.getCachedQueryResults<Bookmark>('bookmark', null, []);
    console.log('Cached query results after create delete api', (cachedQueryResults || []).length);

    // Wait for delete DataOp to be processed and callback to be triggered
    await vi.waitFor(
      () => {
        if (queryCallbackInvoked <= beforeDeleteCount) {
          throw new Error('Query callback not triggered after page deletion');
        }
      },
      { timeout: 5000, interval: 100 },
    );

    // Cleanup
    unwatchQuery();
    expect(queryCallbackInvoked).toBeGreaterThan(2); // At least initial + create + delete callbacks
  }, 15000); // Increased timeout for complex scenario

  it('test basic react component mounting in jsdom', async () => {
    // Test basic React component mounting
    let renderCount = 0;
    let effectCalled = false;
    let cleanupCalled = false;

    const SimpleTestComponent: React.FC = () => {
      const [count, setCount] = React.useState(0);

      React.useEffect(() => {
        effectCalled = true;
        console.log('useEffect called');

        return () => {
          cleanupCalled = true;
          console.log('cleanup called');
        };
      }, []);

      renderCount++;
      console.log(`Component render ${renderCount}, state: ${count}`);

      // Auto-increment count after 100ms to test re-renders
      React.useEffect(() => {
        if (count < 2) {
          const timer = setTimeout(() => setCount((c) => c + 1), 100);
          return () => clearTimeout(timer);
        }
      }, [count]);

      return React.createElement('div', { 'data-testid': 'simple-test' }, `Render ${renderCount}, Count: ${count}`);
    };

    // Create container and mount component
    const container = document.createElement('div');
    container.id = 'test-container';
    document.body.appendChild(container);

    const root = createRoot(container);
    root.render(React.createElement(SimpleTestComponent));

    // Wait for initial render
    await vi.waitFor(
      () => {
        if (renderCount === 0) {
          throw new Error('Component not rendered yet');
        }
      },
      { timeout: 1000 },
    );

    expect(renderCount).toBeGreaterThan(0);
    expect(effectCalled).toBe(true);

    // Wait for re-renders from state updates
    await vi.waitFor(
      () => {
        if (renderCount < 3) {
          // Initial + 2 state updates
          throw new Error(`Not enough renders yet: ${renderCount}`);
        }
      },
      { timeout: 2000 },
    );

    console.log(`Final render count: ${renderCount}`);
    expect(renderCount).toBeGreaterThanOrEqual(3);

    // Cleanup
    root.unmount();
    document.body.removeChild(container);

    // Wait a bit for cleanup to run
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cleanupCalled).toBe(true);

    console.log('Basic React mounting test completed successfully');
  });

  it('test basic react component mounting in jsdom with QueryClient', async () => {
    // Test React component mounting with QueryClient provider
    let renderCount = 0;
    let effectCalled = false;
    let cleanupCalled = false;

    const SimpleQueryClientComponent: React.FC = () => {
      const [count, setCount] = React.useState(0);

      React.useEffect(() => {
        effectCalled = true;
        console.log('useEffect called (with QueryClient)');

        return () => {
          cleanupCalled = true;
          console.log('cleanup called (with QueryClient)');
        };
      }, []);

      renderCount++;
      console.log(`Component render ${renderCount}, state: ${count} (with QueryClient)`);

      // Auto-increment count after 100ms to test re-renders
      React.useEffect(() => {
        if (count < 2) {
          const timer = setTimeout(() => setCount((c) => c + 1), 100);
          return () => clearTimeout(timer);
        }
      }, [count]);

      return React.createElement(
        'div',
        { 'data-testid': 'simple-queryclient-test' },
        `Render ${renderCount}, Count: ${count} (with QueryClient)`,
      );
    };

    // Create QueryClient
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    // Create container and mount component
    const container = document.createElement('div');
    container.id = 'queryclient-test-container';
    document.body.appendChild(container);

    const root = createRoot(container);

    // Mount with QueryClientProvider wrapper
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(SimpleQueryClientComponent),
      ),
    );

    // Wait for initial render
    await vi.waitFor(
      () => {
        if (renderCount === 0) {
          throw new Error('Component not rendered yet');
        }
      },
      { timeout: 1000 },
    );

    expect(renderCount).toBeGreaterThan(0);
    expect(effectCalled).toBe(true);

    // Wait for re-renders from state updates
    await vi.waitFor(
      () => {
        if (renderCount < 3) {
          // Initial + 2 state updates
          throw new Error(`Not enough renders yet: ${renderCount}`);
        }
      },
      { timeout: 2000 },
    );

    console.log(`Final render count: ${renderCount} (with QueryClient)`);
    expect(renderCount).toBeGreaterThanOrEqual(3);

    // Cleanup
    root.unmount();
    document.body.removeChild(container);

    // Wait a bit for cleanup to run
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cleanupCalled).toBe(true);

    console.log('Basic React mounting with QueryClient test completed successfully');
  });

  it('test react query invalidation bug - useEntitiesQuery not re-rendering on delete', async () => {
    // Setup connection
    const manager = ConnectionManager.getInstance();
    await waitForConnection(manager);

    // Create QueryRequest
    const request = new QueryRequest({
      type: "bookmark",
      query: null,
      scope: [],
      name: 'test react query invalidation bug',
    });

    // Track renders and data - capture render history to validate what component "sees"
    let renderCount = 0;
    let currentData: Bookmark[] = [];
    let isSuccess = false;
    let testPage: Bookmark | null = null;
    const renderHistory: { render: number; dataLength: number; data: Bookmark[] }[] = [];

    // Create test component that uses useEntitiesQuery
    const TestComponent: React.FC = () => {
      renderCount++;
      const result = useEntitiesQuery<Bookmark>(request);
      currentData = result.data || [];
      isSuccess = result.isSuccess;

      // Capture what the component actually "sees" during this render
      const renderSnapshot = {
        render: renderCount,
        dataLength: currentData.length,
        data: [...currentData], // Deep copy to capture exact state
      };
      renderHistory.push(renderSnapshot);

      console.log(
        `Component render ${renderCount}: ${currentData.length} pages, success: ${isSuccess}, data IDs: [${currentData.map((p) => p.id).join(', ')}]`,
      );

      return React.createElement(
        'div',
        { 'data-testid': 'entity-test' },
        `Render ${renderCount}: ${currentData.length} pages, success: ${isSuccess}`,
      );
    };

    // Create QueryClient like the real app does
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    // Create container and mount component
    const container = document.createElement('div');
    container.id = 'entity-test-container';
    document.body.appendChild(container);

    const root = createRoot(container);

    // Wrap with QueryClientProvider like the real app does (app.tsx:225)
    root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(TestComponent)));

    // Wait for initial data load
    await vi.waitFor(
      () => {
        if (!isSuccess) {
          throw new Error('Component not loaded successfully');
        }
      },
      { timeout: 5000 },
    );

    const initialRenderCount = renderCount;
    const initialPageCount = currentData.length;
    console.log(`Initial: ${initialPageCount} pages, ${initialRenderCount} renders, success: ${isSuccess}`);

    // Create page and verify re-render
    testPage = new Bookmark({ title: `test-invalidation-bug-${Date.now()}` });
    await testPage.save();
    const endpoint = `${GRAPH_API_PREFIX}/${Bookmark.type}`;
    const entitiesJson: IEntity[] = (await apiClient.get<IEntity[]>(endpoint)) as unknown as IEntity[];
    console.log(`Query results after save: ${entitiesJson.length} entities`);
    console.log(`Waiting for ${renderCount} to be greater than ${initialRenderCount} renders`);
    // Wait for create re-render
    await vi.waitFor(
      () => {
        if (renderCount <= initialRenderCount) {
          throw new Error(`Component not re-rendered after page creation. Renders: ${renderCount}`);
        }
      },
      { timeout: 5000, interval: 100 },
    );

    const afterCreateRenderCount = renderCount;
    const afterCreateRenderIndex = renderHistory.length; // Store array index, not render count
    // Wait for page count to include the new page
    await vi.waitFor(
      () => {
        if (currentData.length <= initialPageCount) {
          throw new Error(`Expected more than ${initialPageCount} pages after create, but got ${currentData.length}`);
        }
      },
      { timeout: 2000 },
    );
    const afterCreatePageCount = currentData.length;
    console.log(`After create: ${afterCreatePageCount} pages, ${afterCreateRenderCount} renders`);
    // Verify page was added
    const foundTestPage = currentData.find((p) => p.id === testPage.id);
    expect(foundTestPage).toBeDefined();
    expect(afterCreatePageCount).toBeGreaterThan(initialPageCount);

    console.log(`After create: ${afterCreatePageCount} pages, ${afterCreateRenderCount} renders`);
    // Capture API stats before deletion
    const deleteCounterBefore = dataManager.apiStats.successfulDELETE;
    const dataEntitiesCountBefore = currentData.length;
    console.log(`Delete counter before deletion: ${deleteCounterBefore}, currentData length: ${currentData.length}`);
    // Delete the page
    dataManager.printStats('before delete');
    await testPage.delete();
    dataManager.printStats('after delete');
    await vi.waitFor(
      () => {
        if (dataManager.apiStats.successfulDELETE != deleteCounterBefore + 1) {
          throw new Error(`Delete counter not increased after deletion. Renders: ${renderCount}`);
        }
      },
      { timeout: 5000, interval: 100 },
    );
    const deleteCounterAfter = dataManager.apiStats.successfulDELETE;
    console.log(`Delete counter after deletion: ${deleteCounterAfter}, currentData length: ${currentData.length}`);
    await vi.waitFor(
      () => {
        if (dataManager.apiStats.successfulDELETE != deleteCounterBefore + 1) {
          throw new Error(`Delete counter not increased after deletion. Renders: ${renderCount}`);
        }
      },
      { timeout: 5000, interval: 100 },
    );
    await vi.waitFor(
      () => {
        if (currentData.length != dataEntitiesCountBefore - 1) {
          throw new Error(
            `Component not re-rendered after deletion. Renders: ${renderCount}, expected > ${afterCreateRenderCount}`,
          );
        }
        console.log('Post delete data updated :currentData length after delete', currentData.length);
      },
      { timeout: 5000, interval: 100 },
    );

    await vi.waitFor(
      () => {
        if (currentData.length >= afterCreatePageCount) {
          throw new Error(`Expected fewer than ${afterCreatePageCount} pages after deletion, but got ${currentData.length}`);
        }
      },
      { timeout: 2000, interval: 100 },
    );
    const finalRenderCount = renderCount;
    const finalPageCount = currentData.length;
    console.log(`After delete: ${finalPageCount} pages, ${finalRenderCount} renders`);

    // Print complete render history to see what component actually "saw"
    console.log('=== RENDER HISTORY ===');
    renderHistory.forEach((snapshot, _index) => {
      const pageIds = snapshot.data.map((p) => p.id).join(', ');
      console.log(`Render ${snapshot.render}: ${snapshot.dataLength} pages [${pageIds}]`);
    });
    console.log('=== END RENDER HISTORY ===');

    // Verify page was removed from results
    const deletedPageStillInResults = currentData.find((p) => p.id === testPage.id);
    expect(deletedPageStillInResults).toBeUndefined();
    expect(finalPageCount).toBeLessThan(afterCreatePageCount);
    expect(finalRenderCount).toBeGreaterThan(afterCreateRenderCount);

    // CRITICAL VALIDATION: Check if component correctly removed the test page after deletion
    const finalRender = renderHistory[renderHistory.length - 1];
    expect(finalRender.dataLength).toBe(afterCreatePageCount - 1);

    // Additional validation: Check if there was a render after deletion without the test page
    const rendersAfterDelete = renderHistory.slice(afterCreateRenderIndex);
    const sawPageRemoved = rendersAfterDelete.some(
      (render) => render.dataLength < afterCreatePageCount,
    );
    expect(sawPageRemoved).toBe(true);
    console.log(
      `✅ Component correctly saw empty array after deletion in ${rendersAfterDelete.length} post-delete renders`,
    );

    // Cleanup
    root.unmount();
    document.body.removeChild(container);

    console.log('React Query invalidation test completed successfully');
  }, 15000);
});

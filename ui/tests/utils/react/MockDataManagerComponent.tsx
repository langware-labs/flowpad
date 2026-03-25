import { dataManager, Page } from '@sdk';
import React, { useState } from 'react';

export interface MockDataManagerComponentProps {
  'data-testid'?: string;
  onPagesLoaded?: (pages: Page[]) => void;
}

/**
 * Simple component to test DataManager integration with React
 */
export function MockDataManagerComponent({
  'data-testid': testId = 'data-manager-component',
  onPagesLoaded,
}: MockDataManagerComponentProps) {
  const [pages, setPages] = useState<Page[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPages = async () => {
    setLoading(true);
    setError(null);

    try {
      // Try to get cached pages first
      const cachedPages = dataManager.getCachedQueryResults<Page>('page', null, []);
      if (cachedPages && cachedPages.length > 0) {
        setPages(cachedPages);
        if (onPagesLoaded) {
          onPagesLoaded(cachedPages);
        }
      } else {
        // If no cached pages, create a test page
        const testPage = new Page({
          title: `Test Page ${Date.now()}`,
        });
        await testPage.save();

        const updatedPages = [testPage];
        setPages(updatedPages);
        if (onPagesLoaded) {
          onPagesLoaded(updatedPages);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pages');
    } finally {
      setLoading(false);
    }
  };

  const createPage = async () => {
    setLoading(true);
    setError(null);

    try {
      const newPage = new Page({
        title: `New Page ${Date.now()}`,
      });
      await newPage.save();

      const updatedPages = [...pages, newPage];
      setPages(updatedPages);
      if (onPagesLoaded) {
        onPagesLoaded(updatedPages);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create page');
    } finally {
      setLoading(false);
    }
  };

  const clearCache = () => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    dataManager.clearCache();
    setPages([]);
    setError(null);
  };

  return (
    <div data-testid={testId}>
      <div data-testid="loading-status">{loading ? 'Loading pages...' : 'Ready'}</div>

      <div data-testid="pages-count">Pages: {pages.length}</div>

      {error && (
        <div data-testid="error-message" role="alert">
          Error: {error}
        </div>
      )}

      <div data-testid="controls">
        <button onClick={loadPages} disabled={loading} data-testid="load-pages-button">
          Load Pages
        </button>

        <button onClick={createPage} disabled={loading} data-testid="create-page-button">
          Create Page
        </button>

        <button onClick={clearCache} disabled={loading} data-testid="clear-cache-button">
          Clear Cache
        </button>
      </div>

      <div data-testid="pages-list">
        {pages.map((page, index) => (
          <div key={page.id || index} data-testid={`page-${index}`}>
            {page.title} (ID: {page.id})
          </div>
        ))}
      </div>
    </div>
  );
}

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import apiClient from '@sdk/client';
import { useRecordSearch, type SearchResult } from '@src/hooks/use-record-search';

vi.mock('@sdk/client', () => ({
  default: { get: vi.fn() },
}));

const result = (name: string): SearchResult => ({
  record_id: `${name}-id`,
  record_type: 'markdown',
  name,
  text: name,
  status: 'indexed',
  scope: 'project',
  created_at: '',
  modified_at: '',
  asset_ref: `/tmp/${name}.md`,
});

describe('useRecordSearch request ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(apiClient.get).mockReset();
  });

  it('ignores an older response after a newer query has completed', async () => {
    vi.useFakeTimers();
    const resolvers = new Map<string, (value: unknown) => void>();
    vi.mocked(apiClient.get).mockImplementation(
      (url: string) =>
        new Promise((resolve) => {
          resolvers.set(new URL(url, 'http://flowpad.local').searchParams.get('q') ?? '', resolve);
        }),
    );

    const { result: hook, rerender } = renderHook(
      ({ query }) => useRecordSearch(query, {}, {}, null, 0),
      { initialProps: { query: 'wiki' } },
    );
    await act(async () => vi.runOnlyPendingTimersAsync());

    rerender({ query: 'wiki-target' });
    await act(async () => vi.runOnlyPendingTimersAsync());

    await act(async () => {
      resolvers.get('wiki-target')?.({ results: [result('wiki-target')] });
      await Promise.resolve();
    });
    expect(hook.current.results.map((row) => row.name)).toEqual(['wiki-target']);

    await act(async () => {
      resolvers.get('wiki')?.({ results: [] });
      await Promise.resolve();
    });
    expect(hook.current.results.map((row) => row.name)).toEqual(['wiki-target']);
  });
});

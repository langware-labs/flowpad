/**
 * A live list re-renders the value a save settled on, not the one it sent.
 *
 * Bug: a DataOp `update` that arrives while a save is in flight notifies the watched
 * queries immediately, but its merge is buffered until the HTTP response lands. The
 * query's render therefore carried what the save SENT — the attached-channels toggle
 * sends `status: "new"` and the backend resolves it to `setup` — and the later merge
 * mutated the shared row in place with no second notify. The Slack mark kept reading
 * "listening" while the source sat in setup, until a reload.
 *
 * Fix: `applyPendingUpdate` notifies every watched query holding the row.
 */
import { dataManager, QueryRequest, Tab, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ID = '3c9d6a1e-8b47-4f0e-9a52-6d1e2f3a4b5c';

function tabJson(extra: object = {}) {
  return { type: 'tab', id: ID, pointer: `lens|claude/transcript/${ID}`, visible: true, title: 'sent', ...extra };
}

describe('DataManager: a query renders the merged save', () => {
  beforeEach(async () => {
    await dataManager.clearCache();
    vi.restoreAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it('re-notifies the query after a DataOp buffered during the save is merged', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValue([tabJson({ title: 'before' })] as any);
    const rendered: string[] = [];
    const request = new QueryRequest({
      type: Tab.type,
      scope: [],
      name: 'test:merged-save',
      callback: (rows: unknown[]) => rendered.push(String((rows[0] as Tab | undefined)?.title)),
    });
    const unsub = await dataManager.watchQuery(request);

    let respond!: (value: unknown) => void;
    const response = new Promise((resolve) => (respond = resolve));
    vi.spyOn(apiClient, 'put').mockReturnValue(response as any);
    vi.spyOn(apiClient, 'post').mockReturnValue(response as any);
    const tab = (dataManager as any).watchedQueries.getWatchedQuery(request).results[0] as Tab;
    tab.title = 'sent';
    const save = tab.save();
    await Promise.resolve();

    // The backend's broadcast of what it stored lands while the PUT is still open.
    (dataManager as any).onDataOp(new TypeId('tab', ID).toString(), 'update', tabJson({ title: 'resolved' }));
    expect(rendered[rendered.length - 1]).toBe('sent'); // the early notify, before the merge

    respond(tabJson({ title: 'resolved' }));
    await save;

    expect(tab.title).toBe('resolved');
    expect(rendered[rendered.length - 1], 'the list never re-rendered the merged row').toBe('resolved');
    unsub?.();
  });
});

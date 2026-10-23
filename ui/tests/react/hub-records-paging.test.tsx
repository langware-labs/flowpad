/**
 * The hub page's record list: the newest page (100), and "Load more" for the rest — the server's
 * `has_more` / `next_offset`, asked inside `filter`. Live backend: the rows and the pages are real.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiClient, Bookmark, GRAPH_API_PREFIX } from '@sdk';
import { HUB_RECORDS_PAGE_SIZE, HubRecordsView } from '@src/pages/hub-browse/HubRecordsView';
import { apiTestSetup } from '../utils/test-utils';

const rowButtons = () =>
  Array.from(document.querySelectorAll('button')).filter((b) => b.dataset.testid !== 'hub-records-load-more');

describe('HubRecordsView pages its list', () => {
  let total = 0;

  beforeAll(async () => {
    await apiTestSetup();
    const existing = ((await apiClient.get<unknown[]>(`${GRAPH_API_PREFIX}/${Bookmark.type}`)) ?? []).length;
    const missing = Math.max(0, HUB_RECORDS_PAGE_SIZE + 5 - existing);
    for (let i = 0; i < missing; i += 10) {
      await Promise.all(
        Array.from({ length: Math.min(10, missing - i) }, (_, k) =>
          new Bookmark({ title: `paging ${i + k} ${Date.now()}`, content: `paging ${i + k}` }).save(),
        ),
      );
    }
    total = ((await apiClient.get<unknown[]>(`${GRAPH_API_PREFIX}/${Bookmark.type}`)) ?? []).length;
  }, 120_000);

  afterAll(() => cleanup());

  it('shows the newest page, then every record after "Load more"', async () => {
    expect(total).toBeGreaterThan(HUB_RECORDS_PAGE_SIZE);
    render(
      <MemoryRouter>
        <HubRecordsView type={Bookmark.type} />
      </MemoryRouter>,
    );
    const more = await screen.findByTestId('hub-records-load-more', {}, { timeout: 15_000 });
    expect(rowButtons().length).toBe(HUB_RECORDS_PAGE_SIZE);

    await act(async () => {
      fireEvent.click(more);
    });
    await waitFor(() => expect(rowButtons().length).toBe(Math.min(total, 2 * HUB_RECORDS_PAGE_SIZE)), {
      timeout: 15_000,
    });
    if (total <= 2 * HUB_RECORDS_PAGE_SIZE) expect(screen.queryByTestId('hub-records-load-more')).toBeNull();
  }, 60_000);
});

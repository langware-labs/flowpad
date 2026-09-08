/**
 * X2 regression lock: the home Feed hydrates every card's target entity through
 * ONE batched ``$IN`` query PER TYPE (warming the shared cache) instead of one
 * ``getByTypeId`` GET (+ ``/watch``) per card (N+1).
 *
 * Drives the REAL ``HomeFeedColumn`` + real entity-hooks over a spied
 * ``dataManager``: ``watchQuery`` serves the FeedEntry list and records the
 * per-type target batches; ``getByTypeIdFromCache`` serves the pre-warmed
 * targets so cards resolve from cache; ``getByTypeId`` (per-card GET) is
 * counted and must never fire for a feed target.
 *
 * FAIL-before: before the fix no per-type target ``$IN`` query was issued.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedEntry, UserNote, dataManager, type QueryRequest } from '@sdk';
import '@src/i18n-init';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() }, currentDock: null }),
}));

vi.mock('@src/hooks/use-feed-mutations', () => ({
  useFeedMutations: () => ({ dismiss: vi.fn(async () => {}) }),
}));

import { HomeFeedColumn } from '@src/pages/home-landing/feed/HomeFeedColumn';

const N = 4; // feed entries, all targeting UserNote → ONE $IN batch of N ids

function makeFeed() {
  const entries: FeedEntry[] = [];
  const notes: UserNote[] = [];
  for (let i = 0; i < N; i++) {
    const noteId = `a${i}aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    notes.push(
      new UserNote({ id: noteId, content: `note ${i}`, created_by: 'someone-else' }),
    );
    entries.push(
      new FeedEntry({
        id: `f${i}ffffff-ffff-4fff-8fff-ffffffffffff`,
        feed_status: 'new',
        created_date: `2026-06-1${i}T12:00:00Z`,
        data: { type_id: `user_note-${noteId}` } as never,
        created_by: 'someone-else',
      }),
    );
  }
  return { entries, notes };
}

describe('Feed batch target hydration (X2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('issues ONE $IN query per target type and no per-card GETs', async () => {
    const { entries, notes } = makeFeed();

    const cache = new Map<string, UserNote>();
    for (const n of notes) cache.set(n.typeId.toString(), n);

    vi.spyOn(dataManager, 'getByTypeIdFromCache').mockImplementation(
      (tid) => (cache.get(tid.toString()) as never) ?? null,
    );
    vi.spyOn(dataManager, 'subscribe').mockImplementation(() => () => {});
    const getByTypeIdSpy = vi
      .spyOn(dataManager, 'getByTypeId')
      .mockImplementation(async (tid) => (cache.get(tid.toString()) as never) ?? null);

    const watchRequests: QueryRequest[] = [];
    vi.spyOn(dataManager, 'watchQuery').mockImplementation(async (request) => {
      watchRequests.push(request);
      if (request.type === FeedEntry.type) {
        request.callback?.(entries as never[]);
      } else if (request.type === UserNote.type) {
        request.callback?.(notes as never[]);
      } else {
        request.callback?.([]);
      }
      return () => {};
    });
    vi.spyOn(dataManager, 'query').mockImplementation(async (request) =>
      (request.type === FeedEntry.type ? (entries as never[]) : []),
    );

    render(
      <I18nProvider i18n={i18n}>
        <HomeFeedColumn />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('home-feed-column')).toBeInTheDocument();
      // Cards rendered their note bodies (resolved from cache).
      expect(screen.getByText('note 0')).toBeInTheDocument();
    });

    // Exactly ONE UserNote $IN batch — not N per-card.
    const noteWatches = watchRequests.filter((r) => r.type === UserNote.type);
    expect(noteWatches.length).toBe(1);

    const wire = noteWatches[0].query?.toJSON() as
      | { filter: { match: { op: string; operands: unknown[] } } }
      | undefined;
    expect(wire?.filter.match.op).toBe('$IN');
    expect(wire?.filter.match.operands[0]).toBe('id');
    expect(Array.isArray(wire?.filter.match.operands[1])).toBe(true);
    expect((wire?.filter.match.operands[1] as string[]).length).toBe(N);

    // No per-card GET for the target type — cards read from the warmed cache.
    const noteGets = getByTypeIdSpy.mock.calls.filter(
      ([tid]) => tid.type === UserNote.type,
    );
    expect(noteGets.length).toBe(0);
  });
});

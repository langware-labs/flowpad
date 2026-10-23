/** A stream inbox page is answered by the backend: the view's clause, the keyset and the size ride
 *  in the query, and the same query decides which pushed rows join a live page. */
import { describe, expect, it } from 'vitest';
import { TypeId, User } from '@sdk';
import {
  conversationsPageRequest,
  newerBoundaryRequest,
  newerPageBefore,
  STREAM_INBOX_PAGE_SIZE,
} from '@src/components/stream-inbox-view/channel-owner';

const OWNER = new TypeId(User.type, '11111111-1111-4111-8111-111111111111');
const scope = { owner: OWNER };
const row = (fields: Record<string, unknown>) => ({ owner: OWNER.toString(), updated_date: '2026-10-10T00:00:00.000Z', ...fields });

describe('conversationsPageRequest', () => {
  it('is the latest page, newest first, 100 rows', () => {
    const q = conversationsPageRequest(scope, 'all', null).query!;
    expect(STREAM_INBOX_PAGE_SIZE).toBe(100);
    expect(q.limit).toBe(100);
    expect(q.order_by).toEqual([{ updated_date: 'desc' }, { id: 'asc' }]);
  });

  it('all hides archived rows, keeps rows the recompute has not stamped', () => {
    const q = conversationsPageRequest(scope, 'all', null).query!;
    expect(q.validate(row({ archived: false }))).toBe(true);
    expect(q.validate(row({}))).toBe(true);
    expect(q.validate(row({ archived: true }))).toBe(false);
  });

  it('a conversation deleted on the hub is not listed; a row kept here (no deleted_at) is', () => {
    const q = conversationsPageRequest(scope, 'all', null).query!;
    expect(q.validate(row({}))).toBe(true);
    expect(q.validate(row({ deleted_at: '2026-10-20T00:00:00.000Z' }))).toBe(false);
  });

  it('unread and archived are their own pages', () => {
    const unread = conversationsPageRequest(scope, 'unread', null).query!;
    expect(unread.validate(row({ archived: false, is_unread: true }))).toBe(true);
    expect(unread.validate(row({ archived: false, is_unread: false }))).toBe(false);
    expect(unread.validate(row({ archived: true, is_unread: true }))).toBe(false);
    const archived = conversationsPageRequest(scope, 'archived', null).query!;
    expect(archived.validate(row({ archived: true }))).toBe(true);
    expect(archived.validate(row({ archived: false }))).toBe(false);
  });

  it('an older page lists only rows older than its bound, so a new arrival never joins it', () => {
    const q = conversationsPageRequest(scope, 'all', '2026-10-10T00:00:00.000Z').query!;
    expect(q.validate(row({ updated_date: '2026-10-09T00:00:00.000Z' }))).toBe(true);
    expect(q.validate(row({ updated_date: '2026-10-15T00:00:00.000Z' }))).toBe(false);
  });

  it('another owner never lands on the page', () => {
    const q = conversationsPageRequest(scope, 'all', null).query!;
    expect(q.validate(row({ owner: 'agent-22222222-2222-4222-8222-222222222222' }))).toBe(false);
  });
});

describe('newerBoundaryRequest', () => {
  it('reads the page of rows above the newest row by keyset, oldest first — no offset', () => {
    const q = newerBoundaryRequest(scope, 'all', '2026-10-10T00:00:00.000Z').query!;
    expect([q.limit, q.offset]).toEqual([STREAM_INBOX_PAGE_SIZE, undefined]);
    expect(q.order_by).toEqual([{ updated_date: 'asc' }, { id: 'asc' }]);
    expect(q.validate(row({ updated_date: '2026-10-11T00:00:00.000Z' }))).toBe(true);
    expect(q.validate(row({ updated_date: '2026-10-09T00:00:00.000Z' }))).toBe(false);
    const wire = JSON.stringify(q.toJSON());
    expect(wire).not.toContain('offset');
  });

  it('bounds the newer page just past the last row above, or is now when no full page is above', () => {
    const above = Array.from({ length: STREAM_INBOX_PAGE_SIZE }, (_, i) => ({
      updated_date: new Date(Date.UTC(2026, 9, 11, 0, 0, i)).toISOString(),
    }));
    expect(newerPageBefore(above, true)).toBe('2026-10-11T00:01:39.001Z');
    expect(newerPageBefore(above, false)).toBeNull();
    expect(newerPageBefore(above.slice(1), true)).toBeNull();
  });
});

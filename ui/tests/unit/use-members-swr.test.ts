/**
 * useMembers — stale-while-revalidate + availability gating.
 *
 * The roster is 100% hub-driven; the local ``Entity.members`` is a READ CACHE.
 * This locks the behavior the cleanup introduced:
 *  - paint the cache immediately, then let the HUB answer WIN (inverting the old
 *    "cache wins when non-empty" rule) — a roster the hub emptied now clears;
 *  - on a refresh failure keep the cache (stale) and flag ``stale``;
 *  - when membership is unavailable (signed out / Local mode), don't fetch at
 *    all and report ``available:false``.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const A = { user_id: 'a', role: 'owner' };
const B = { user_id: 'b', role: 'member' };

let entity: { members?: unknown[] } | null = { members: [A] };
let availability = { available: true, reason: 'available' as const };

vi.mock('@src/hooks/entity-hooks', () => ({
  useEntity: () => ({ data: entity }),
}));
vi.mock('@src/hooks/use-membership-availability', () => ({
  useMembershipAvailability: () => availability,
}));
vi.mock('@sdk', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return { ...actual, getMembers: vi.fn() };
});

import { getMembers, TypeId } from '@sdk';
import { useMembers } from '@src/hooks/use-members';

const mockedGetMembers = vi.mocked(getMembers);
const typeId = new TypeId('conversation', '550e8400-e29b-41d4-a716-446655440099');

describe('useMembers — stale-while-revalidate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    entity = { members: [A] };
    availability = { available: true, reason: 'available' };
  });

  it('paints the cache immediately, then the hub answer wins (overlay)', async () => {
    mockedGetMembers.mockResolvedValue([A, B] as any);
    const { result } = renderHook(() => useMembers(typeId));

    // First paint: the local cache.
    expect(result.current.members).toEqual([A]);

    await waitFor(() => expect(result.current.members).toEqual([A, B]));
    expect(result.current.stale).toBe(false);
    expect(result.current.ready).toBe(true);
  });

  it('an empty hub roster CLEARS a populated cache (inverts cache-wins)', async () => {
    mockedGetMembers.mockResolvedValue([] as any);
    const { result } = renderHook(() => useMembers(typeId));

    expect(result.current.members).toEqual([A]); // cache first
    await waitFor(() => expect(result.current.members).toEqual([])); // hub wins
  });

  it('on refresh failure keeps the cache and flags stale', async () => {
    mockedGetMembers.mockRejectedValue(new Error('hub unreachable'));
    const { result } = renderHook(() => useMembers(typeId));

    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.members).toEqual([A]); // cached roster preserved
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('when unavailable: does NOT fetch, reports available:false and ready', async () => {
    availability = { available: false, reason: 'unauthenticated' } as any;
    const { result } = renderHook(() => useMembers(typeId));

    expect(mockedGetMembers).not.toHaveBeenCalled();
    expect(result.current.available).toBe(false);
    expect(result.current.reason).toBe('unauthenticated');
    expect(result.current.updating).toBe(false);
    // ready is true (nothing to wait for) so gated UI doesn't stall.
    expect(result.current.ready).toBe(true);
    // Falls back to the cache for display, but the surface disables actions.
    expect(result.current.members).toEqual([A]);
  });

  it('null typeId → empty, no fetch', () => {
    entity = null; // no resolved entity → no cache to fall back to
    const { result } = renderHook(() => useMembers(null));
    expect(mockedGetMembers).not.toHaveBeenCalled();
    expect(result.current.members).toEqual([]);
  });
});

describe('useMembers — addMembers on a non-project entity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availability = { available: true, reason: 'available' };
  });

  it('invites everyone even when one fails, refreshes the roster, and names who failed', async () => {
    const invited: string[] = [];
    entity = {
      members: [A],
      inviteMember: vi.fn(async (who: string) => {
        if (who === 'bad@example.test') throw new Error('no such user');
        invited.push(who);
      }),
    } as any;
    mockedGetMembers.mockResolvedValue([A] as any);
    const { result } = renderHook(() => useMembers(typeId));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const fetchesBefore = mockedGetMembers.mock.calls.length;

    await expect(
      result.current.addMembers([
        { idOrEmail: 'one@example.test' },
        { idOrEmail: 'bad@example.test' },
        { idOrEmail: 'two@example.test' },
      ]),
    ).rejects.toThrow(/bad@example\.test.*no such user/);

    expect(invited).toEqual(['one@example.test', 'two@example.test']);
    expect(mockedGetMembers.mock.calls.length).toBeGreaterThan(fetchesBefore);
  });
});

describe('useMembers — follows the stored roster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    entity = { members: [A, B] };
    availability = { available: true, reason: 'available' };
  });

  it('reads the membership again when the hub pushes a changed roster (someone left elsewhere)', async () => {
    mockedGetMembers.mockResolvedValueOnce([A, B] as any).mockResolvedValueOnce([A] as any);
    const { result, rerender } = renderHook(() => useMembers(typeId));
    await waitFor(() => expect(result.current.members).toEqual([A, B]));

    entity = { members: [A] };
    rerender();

    await waitFor(() => expect(result.current.members).toEqual([A]));
    expect(mockedGetMembers).toHaveBeenCalledTimes(2);
  });

  it('does not read it again while the stored roster is unchanged', async () => {
    mockedGetMembers.mockResolvedValue([A, B] as any);
    const { result, rerender } = renderHook(() => useMembers(typeId));
    await waitFor(() => expect(result.current.members).toEqual([A, B]));
    rerender();
    expect(mockedGetMembers).toHaveBeenCalledTimes(1);
  });
});

describe('useMembers — a roster the caller may no longer read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availability = { available: true, reason: 'available' };
  });

  it('shows the pushed roster, not its own earlier read, once the read is refused', async () => {
    entity = { members: [A, B] };
    mockedGetMembers.mockResolvedValueOnce([A, B] as any).mockRejectedValueOnce(new Error('403'));
    const { result, rerender } = renderHook(() => useMembers(typeId));
    await waitFor(() => expect(result.current.members).toEqual([A, B]));

    entity = { members: [A] }; // B returned the ticket; the hub pushed the roster without them
    rerender();

    await waitFor(() => expect(result.current.members).toEqual([A]));
    expect(result.current.stale).toBe(true);
  });
});

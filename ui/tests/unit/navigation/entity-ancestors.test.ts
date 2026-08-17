/**
 * The containment walk behind the nav bar's breadcrumb.
 *
 * The interesting cases are all failure modes: the chain is user data, so it can
 * cycle, dangle, or be absurdly deep, and none of those may take down the
 * address bar. A truncated trail is useful; a thrown error is not.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { dataManager } from '@sdk';
import { resolveAncestorChain, MAX_ANCESTOR_HOPS } from '@src/navigation/entity-ancestors';

// Spy on the ONE method under test rather than replacing the whole dataManager:
// a wholesale module mock also captures the unrelated sdk traffic the test tier
// makes, which then lands in this fixture with arguments it knows nothing about.
let getByTypeId: ReturnType<typeof vi.spyOn>;

/** Install a fixture graph keyed by `<type>-<id>` for the duration of one test. */
function graph(rows: Record<string, { parent_type_id?: string | null }>) {
  getByTypeId = vi.spyOn(dataManager, 'getByTypeId');
  getByTypeId.mockImplementation(((typeId: { toString(): string }) => {
    const row = rows[typeId.toString()];
    return Promise.resolve(row ? { ...row, typeId } : null);
  }) as never);
  return getByTypeId;
}

const A = 'markdown-11111111-1111-4111-8111-111111111111';
const B = 'markdown-22222222-2222-4222-8222-222222222222';
const C = 'markdown-33333333-3333-4333-8333-333333333333';
const PROJECT = 'project-99999999-9999-4999-8999-999999999999';

afterEach(() => vi.restoreAllMocks());

describe('resolveAncestorChain', () => {
  it('collects the chain nearest-first', async () => {
    graph({ [A]: { parent_type_id: B }, [B]: { parent_type_id: C }, [C]: {} });

    const chain = await resolveAncestorChain(A);

    expect(chain.map((n) => n.typeId.toString())).toEqual([A, B, C]);
  });

  it('returns nothing when there is no parent', async () => {
    graph({});
    expect(await resolveAncestorChain(null)).toEqual([]);
    expect(await resolveAncestorChain(undefined)).toEqual([]);
  });

  it('terminates on a cycle, visiting each node once', async () => {
    graph({ [A]: { parent_type_id: B }, [B]: { parent_type_id: A } });

    const chain = await resolveAncestorChain(A);

    expect(chain.map((n) => n.typeId.toString())).toEqual([A, B]);
  });

  it('stops at the project — it is the leading crumb, never a middle one', async () => {
    graph({ [A]: { parent_type_id: PROJECT }, [PROJECT]: {} });

    const chain = await resolveAncestorChain(A);

    expect(chain.map((n) => n.typeId.toString())).toEqual([A]);
  });

  it('caps an absurdly deep chain', async () => {
    // A 20-deep chain of distinct rows, each pointing at the next.
    const rows: Record<string, { parent_type_id?: string | null }> = {};
    const id = (n: number) => `markdown-${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
    for (let n = 0; n < 20; n++) rows[id(n)] = { parent_type_id: id(n + 1) };
    graph(rows);

    const chain = await resolveAncestorChain(id(0));

    expect(chain).toHaveLength(MAX_ANCESTOR_HOPS);
  });

  it('truncates at a missing row instead of failing', async () => {
    graph({ [A]: { parent_type_id: B } }); // B is absent

    const chain = await resolveAncestorChain(A);

    expect(chain.map((n) => n.typeId.toString())).toEqual([A]);
  });

  it('truncates when a fetch rejects', async () => {
    const spy = vi.spyOn(dataManager, 'getByTypeId');
    spy.mockImplementation(((typeId: { toString(): string }) =>
      typeId.toString() === A
        ? Promise.resolve({ parent_type_id: B, typeId })
        : Promise.reject(new Error('404'))) as never);

    await expect(resolveAncestorChain(A)).resolves.toHaveLength(1);
  });

  it('stops at a malformed parent ref, keeping what it already walked', async () => {
    graph({ [A]: { parent_type_id: 'not-a-typeid' } });

    const chain = await resolveAncestorChain(A);

    expect(chain.map((n) => n.typeId.toString())).toEqual([A]);
  });

  it('yields nothing when the starting ref itself is malformed', async () => {
    graph({});

    await expect(resolveAncestorChain('not-a-typeid')).resolves.toEqual([]);
  });

  it('abandons the walk when the caller navigates away', async () => {
    graph({ [A]: { parent_type_id: B }, [B]: { parent_type_id: C }, [C]: {} });
    let live = true;

    const chain = await resolveAncestorChain(A, () => {
      const wasLive = live;
      live = false; // the dock changed after the first hop
      return wasLive;
    });

    // Everything is discarded — a stale trail must never reach the bar.
    expect(chain).toEqual([]);
  });
});

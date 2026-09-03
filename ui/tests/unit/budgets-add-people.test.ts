/**
 * Putting people on a team budget: the add-vs-update decision and the failure reporting.
 *
 * Two behaviours are load-bearing and easy to regress:
 *
 * * a repeated address must RE-BUDGET the person, never mint them a second wallet — re-uploading a
 *   corrected sheet is how a whole team gets re-budgeted;
 * * a wallet whose invitation failed must be reported as a failure, not as a success — otherwise
 *   the owner learns about it when the person says "I can't see any budget".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const POOL = `llm_endpoint-${UUID(1)}`;

const h = vi.hoisted(() => ({
  save: vi.fn(),
  del: vi.fn(),
  allocate: vi.fn(),
  share: vi.fn(),
}));

vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dataManager: { ...(actual.dataManager as object), save: h.save, delete: h.del },
    llmEndpointsService: { ...(actual.llmEndpointsService as object), allocate: h.allocate },
  };
});
vi.mock('@src/components/llm-endpoints/share-endpoint', () => ({
  shareEndpointByEmail: h.share,
}));

import {
  addPeopleToTeam,
  indexByEmail,
  removeAllowance,
  setLifetimeCap,
} from '@src/components/organization/budgets/add-people';

const member = (over: Partial<Record<string, unknown>> = {}) => ({
  endpoint_id: `llm_endpoint-${UUID(9)}`,
  name: 'Ada',
  email: 'ada@example.com',
  user_id: UUID(8),
  limit_usd: 10,
  spent_usd: 0,
  system_default: false,
  ...over,
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('addPeopleToTeam', () => {
  it('allocates and invites someone new', async () => {
    h.allocate.mockResolvedValue({ id: UUID(2), type: 'llm_endpoint', name: 'Alan' });
    h.share.mockResolvedValue({ granted: ['alan@example.com'], failed: [] });

    const outcome = await addPeopleToTeam(POOL, [{ name: 'Alan', email: 'alan@example.com', budget: 25 }], []);

    expect(outcome).toEqual({ added: ['alan@example.com'], updated: [], failed: [] });
    // The pool reaches `allocate` as a BARE uuid — a typeid in an action path answers 422.
    expect(h.allocate).toHaveBeenCalledWith(UUID(1), { name: 'Alan', limits: { cost_usd_total: 25 } });
    expect(h.share).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(2) }), ['alan@example.com']);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('re-budgets someone already on the pool instead of allocating a second wallet', async () => {
    const existing = member({ limit_usd: 10 });

    const outcome = await addPeopleToTeam(POOL, [{ name: 'Ada', email: 'ada@example.com', budget: 80 }], [existing]);

    expect(outcome).toEqual({ added: [], updated: ['ada@example.com'], failed: [] });
    expect(h.allocate).not.toHaveBeenCalled();
    expect(h.share).not.toHaveBeenCalled();
    // Only `cost_usd_total` is named: `limits` is a MERGED update on the hub, and restating the
    // rest is how the other limits get silently blanked.
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(9), type: 'llm_endpoint' }), [], {
      limits: { cost_usd_total: 80 },
    });
  });

  it('matches an existing person however the sheet cased their address', async () => {
    const outcome = await addPeopleToTeam(
      POOL,
      [{ name: 'A', email: 'ada@example.com', budget: 1 }],
      [member({ email: 'Ada@Example.com' })],
    );
    expect(outcome.updated).toEqual(['ada@example.com']);
    expect(h.allocate).not.toHaveBeenCalled();
  });

  it('also updates the hub-made per-user default rather than shadowing it', async () => {
    const outcome = await addPeopleToTeam(
      POOL,
      [{ name: 'Ada', email: 'ada@example.com', budget: 5 }],
      [member({ system_default: true })],
    );
    expect(outcome.updated).toEqual(['ada@example.com']);
    expect(h.allocate).not.toHaveBeenCalled();
  });

  it('reports a wallet whose invitation failed as a failure', async () => {
    h.allocate.mockResolvedValue({ id: UUID(3), type: 'llm_endpoint', name: 'Ghost' });
    h.share.mockResolvedValue({ granted: [], failed: [{ email: 'ghost@example.com', reason: 'Sign in to share' }] });

    const outcome = await addPeopleToTeam(POOL, [{ name: 'Ghost', email: 'ghost@example.com', budget: 1 }], []);

    expect(outcome.added).toEqual([]);
    expect(outcome.failed).toEqual([{ email: 'ghost@example.com', reason: 'Sign in to share' }]);
  });

  it('does not let one bad row cost the others', async () => {
    h.allocate
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce({ id: UUID(4), type: 'llm_endpoint', name: 'B' });
    h.share.mockResolvedValue({ granted: ['b@example.com'], failed: [] });

    const outcome = await addPeopleToTeam(
      POOL,
      [
        { name: 'A', email: 'a@example.com', budget: 1 },
        { name: 'B', email: 'b@example.com', budget: 2 },
      ],
      [],
    );

    expect(outcome.added).toEqual(['b@example.com']);
    expect(outcome.failed.map((f) => f.email)).toEqual(['a@example.com']);
  });

  it('sends a blank amount through as no limit', async () => {
    h.allocate.mockResolvedValue({ id: UUID(5), type: 'llm_endpoint', name: 'C' });
    h.share.mockResolvedValue({ granted: ['c@example.com'], failed: [] });

    await addPeopleToTeam(POOL, [{ name: 'C', email: 'c@example.com', budget: null }], []);

    expect(h.allocate).toHaveBeenCalledWith(UUID(1), { name: 'C', limits: { cost_usd_total: null } });
  });
});

describe('indexByEmail', () => {
  it('lower-cases and keeps the first row for an address', () => {
    const first = member({ endpoint_id: `llm_endpoint-${UUID(6)}`, email: 'Ada@Example.com' });
    const second = member({ endpoint_id: `llm_endpoint-${UUID(7)}`, email: 'ada@example.com' });
    expect(indexByEmail([first, second] as never).get('ada@example.com')).toBe(first);
  });

  it('skips a row with no address', () => {
    expect(indexByEmail([member({ email: null })] as never).size).toBe(0);
  });
});

describe('the single writes', () => {
  it('clears a cap with null rather than zero', async () => {
    await setLifetimeCap(`llm_endpoint-${UUID(1)}`, null);
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(1) }), [], {
      limits: { cost_usd_total: null },
    });
  });

  it('deletes by typeid', async () => {
    await removeAllowance(`llm_endpoint-${UUID(1)}`);
    expect(h.del).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(1), type: 'llm_endpoint' }));
  });
});

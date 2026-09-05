/**
 * Putting people on a team budget: the add-vs-update decision and the failure reporting.
 *
 * Two behaviours are load-bearing and easy to regress:
 *
 * * a repeated address must RE-BUDGET the person, never mint them a second wallet — re-uploading a
 *   corrected sheet is how a whole team gets re-budgeted;
 * * a wallet whose invitation failed must be reported as a failure, not as a success — otherwise
 *   the owner learns about it when the person says "I can't see any budget".
 *
 * And the third, added after two people were found spending models their team had never allowed:
 * everyone who lands must be invited to the TEAM as well. Sharing a wallet is a role on the
 * ENDPOINT; only a role on the TEAM makes `get_user_teams` see them, and without it the hub mints
 * their default off the ORGANISATION and hands them its whole model list instead of the team's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const UUID = (n: number) => `550e8400-e29b-41d4-a716-4466554400${String(n).padStart(2, '0')}`;
const POOL = `llm_endpoint-${UUID(1)}`;
const TEAM = UUID(2);

const h = vi.hoisted(() => ({
  save: vi.fn(),
  del: vi.fn(),
  allocate: vi.fn(),
  share: vi.fn(),
  inviteToTeam: vi.fn(),
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
vi.mock('@src/components/organization/budgets/invite-to-team', () => ({
  inviteToTeamByEmail: h.inviteToTeam,
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

beforeEach(() => {
  // The team invite is part of every add now; the cases below are about the WALLET, so it lands
  // by default and the two cases that care about it say so themselves.
  h.inviteToTeam.mockResolvedValue({ invited: [], already: [], failed: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('addPeopleToTeam', () => {
  it('allocates and invites someone new', async () => {
    h.allocate.mockResolvedValue({ id: UUID(2), type: 'llm_endpoint', name: 'Alan' });
    h.share.mockResolvedValue({ granted: ['alan@example.com'], failed: [] });

    const outcome = await addPeopleToTeam(POOL, TEAM, [{ name: 'Alan', email: 'alan@example.com', budget: 25 }], []);

    expect(outcome).toEqual({ added: ['alan@example.com'], updated: [], failed: [] });
    // The pool reaches `allocate` as a BARE uuid — a typeid in an action path answers 422.
    expect(h.allocate).toHaveBeenCalledWith(UUID(1), { name: 'Alan', limits: { cost_usd_total: 25 } });
    expect(h.share).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(2) }), ['alan@example.com']);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('re-budgets someone already on the pool instead of allocating a second wallet', async () => {
    const existing = member({ limit_usd: 10 });

    const outcome = await addPeopleToTeam(
      POOL,
      TEAM,
      [{ name: 'Ada', email: 'ada@example.com', budget: 80 }],
      [existing],
    );

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
      TEAM,
      [{ name: 'A', email: 'ada@example.com', budget: 1 }],
      [member({ email: 'Ada@Example.com' })],
    );
    expect(outcome.updated).toEqual(['ada@example.com']);
    expect(h.allocate).not.toHaveBeenCalled();
  });

  it('also updates the hub-made per-user default rather than shadowing it', async () => {
    const outcome = await addPeopleToTeam(
      POOL,
      TEAM,
      [{ name: 'Ada', email: 'ada@example.com', budget: 5 }],
      [member({ system_default: true })],
    );
    expect(outcome.updated).toEqual(['ada@example.com']);
    expect(h.allocate).not.toHaveBeenCalled();
  });

  it('reports a wallet whose invitation failed as a failure, and takes the wallet back', async () => {
    h.allocate.mockResolvedValue({ id: UUID(3), type: 'llm_endpoint', name: 'Ghost' });
    h.share.mockResolvedValue({
      granted: [],
      failed: [{ email: 'ghost@example.com', reason: 'Sign in to share', accessLanded: false }],
    });

    const outcome = await addPeopleToTeam(POOL, TEAM, [{ name: 'Ghost', email: 'ghost@example.com', budget: 1 }], []);

    expect(outcome.added).toEqual([]);
    expect(outcome.failed).toEqual([{ email: 'ghost@example.com', reason: 'Sign in to share' }]);
    // The half-written wallet must not survive the failure. Left behind it shows in the roster
    // with an amount against it, and pressing Add again mints a SECOND one -- an allowance nobody
    // was granted carries no email for `indexByEmail` to match.
    expect(h.del).toHaveBeenCalledWith(expect.objectContaining({ id: UUID(3), type: 'llm_endpoint' }));
  });

  it('keeps the wallet when the share landed and only the email bounced', async () => {
    // THE 5xx CASE. Auto-accept writes the role edge before the mail step, so the recipient can
    // already reach this budget -- rolling it back would take away a share that worked.
    h.allocate.mockResolvedValue({ id: UUID(5), type: 'llm_endpoint', name: 'Mailless' });
    h.share.mockResolvedValue({
      granted: [],
      failed: [
        {
          email: 'mailless@example.com',
          reason: 'Access granted, but the invitation email failed to send',
          accessLanded: true,
        },
      ],
    });

    const outcome = await addPeopleToTeam(POOL, TEAM, [{ name: 'M', email: 'mailless@example.com', budget: 1 }], []);

    expect(outcome.failed[0].email).toEqual('mailless@example.com');
    expect(h.del).not.toHaveBeenCalled();
  });

  it('still reports the share failure when the roll-back itself fails', async () => {
    // The owner needs the reason the SHARE bounced, not the reason the cleanup did. A rollback
    // that does not land leaves exactly the orphan we had before -- no worse.
    h.allocate.mockResolvedValue({ id: UUID(6), type: 'llm_endpoint', name: 'Stuck' });
    h.share.mockResolvedValue({
      granted: [],
      failed: [{ email: 'stuck@example.com', reason: 'Only the budget’s owner can share it', accessLanded: false }],
    });
    h.del.mockRejectedValueOnce(new Error('delete blew up'));

    const outcome = await addPeopleToTeam(POOL, TEAM, [{ name: 'S', email: 'stuck@example.com', budget: 1 }], []);

    expect(outcome.failed).toEqual([{ email: 'stuck@example.com', reason: 'Only the budget’s owner can share it' }]);
  });

  it('does not let one bad row cost the others', async () => {
    h.allocate
      .mockRejectedValueOnce(new Error('nope'))
      .mockResolvedValueOnce({ id: UUID(4), type: 'llm_endpoint', name: 'B' });
    h.share.mockResolvedValue({ granted: ['b@example.com'], failed: [] });

    const outcome = await addPeopleToTeam(
      POOL,
      TEAM,
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

    await addPeopleToTeam(POOL, TEAM, [{ name: 'C', email: 'c@example.com', budget: null }], []);

    expect(h.allocate).toHaveBeenCalledWith(UUID(1), { name: 'C', limits: { cost_usd_total: null } });
  });
});

describe('addPeopleToTeam — joining the team', () => {
  it('puts everyone who landed on the team, updated people included', async () => {
    // The updated ones matter most: they are the rows added BEFORE this flow joined the team, and
    // re-adding them is what repairs a person the hub currently sees as having no team at all.
    h.allocate.mockResolvedValue({ id: UUID(3), type: 'llm_endpoint', name: 'Alan' });
    h.share.mockResolvedValue({ granted: ['alan@example.com'], failed: [] });
    const existing = member({ email: 'ada@example.com' });

    const outcome = await addPeopleToTeam(
      POOL,
      TEAM,
      [
        { name: 'Alan', email: 'alan@example.com', budget: 25 },
        { name: 'Ada', email: 'ada@example.com', budget: 80 },
      ],
      [existing] as never,
    );

    expect(outcome.failed).toEqual([]);
    expect(h.inviteToTeam).toHaveBeenCalledTimes(1);
    const [teamId, emails] = h.inviteToTeam.mock.calls[0];
    expect(teamId).toBe(TEAM);
    expect([...(emails as string[])].sort()).toEqual(['ada@example.com', 'alan@example.com']);
  });

  it('never invites somebody whose wallet failed', async () => {
    // They have nothing to spend; putting them on the team would say the opposite.
    h.allocate.mockRejectedValue(new Error('no budget left'));

    const outcome = await addPeopleToTeam(POOL, TEAM, [{ name: 'X', email: 'x@example.com', budget: 1 }], []);

    expect(outcome.failed).toHaveLength(1);
    expect(h.inviteToTeam).not.toHaveBeenCalled();
  });

  it('reports a failed team invite and keeps the wallet', async () => {
    // Undoing a working budget to report a membership problem is the worse outcome — and pressing
    // Add again retries exactly this row, because the invite is idempotent.
    h.allocate.mockResolvedValue({ id: UUID(4), type: 'llm_endpoint', name: 'Bea' });
    h.share.mockResolvedValue({ granted: ['bea@example.com'], failed: [] });
    h.inviteToTeam.mockResolvedValue({
      invited: [],
      already: [],
      failed: [{ email: 'bea@example.com', reason: 'not allowed to invite' }],
    });

    const outcome = await addPeopleToTeam(POOL, TEAM, [{ name: 'Bea', email: 'bea@example.com', budget: 5 }], []);

    expect(outcome.added).toEqual(['bea@example.com']);
    expect(outcome.failed[0].reason).toContain('not added to the team');
    expect(h.del).not.toHaveBeenCalled();
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

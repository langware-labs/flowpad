/** `buildSourceTree` — parents from the hub, depth-first, sponsor filter with dimmed ancestors. */
import { describe, expect, it } from 'vitest';

import { LLMEndpoint } from '@sdk';

import {
  FLOWPAD_ACCOUNT_ID,
  childrenOf,
  costLeft,
  fundedBy,
  funderName,
  fundingPath,
  hopCostLeft,
  resetOf,
  sourceRows,
  tightestLeft,
} from '@src/components/token-plan/source-tree';

function ep(id: string, parents: string[], scopeKind: string | null, name = id): LLMEndpoint {
  const e = new LLMEndpoint({ id, name } as never);
  e.expand = {
    source_ids: parents.map((p) => `llm_endpoint-${p}`),
    scope_kind: scopeKind,
    remaining: [{ key: 'cost_usd_total', limit: 10, used: 4, remaining: 6, window: 'total', resets_at: null }],
  };
  return e;
}

const ID = {
  root: '10000000-0000-4000-8000-000000000000',
  org: '20000000-0000-4000-8000-000000000000',
  team: '30000000-0000-4000-8000-000000000000',
  key: '40000000-0000-4000-8000-000000000000',
  loose: '50000000-0000-4000-8000-000000000000',
  'not-visible': '60000000-0000-4000-8000-000000000000',
} as const;

const root = ep(ID['root'], [], 'global', 'OpenRouter');
const org = ep(ID['org'], [ID['root']], 'organization', 'Org pool');
const team = ep(ID['team'], [ID['org']], 'team', 'Team');
const key = ep(ID['key'], [ID['team']], 'user', 'My key');

describe('sourceRows', () => {
  it('keeps your keyed roots, received budgets and unfunded roots; drops allocations and disabled rows', () => {
    const own = (e: LLMEndpoint, key = true) => {
      e.expand = { ...e.expand, roles: ['owner'] as never, allowed_actions: ['allocate'] as never };
      (e as { credential_hint: string }).credential_hint = key ? '****e2da' : '';
      return e;
    };
    const received = (e: LLMEndpoint) => {
      e.expand = { ...e.expand, roles: ['reader'] as never, allowed_actions: ['read'] as never };
      return e;
    };
    const keyRoot = own(ep(ID['root'], [], null, 'worker root'));
    const alloc = own(ep(ID['org'], [ID['root']], 'user', 'claude budget'), false);
    const mine = received(ep(ID['key'], [FLOWPAD_ACCOUNT_ID], 'user', 'my default'));
    const dead = own(ep(ID['team'], [], null, 'dead root'), false);
    const off = received(ep(ID['loose'], [FLOWPAD_ACCOUNT_ID], 'user', 'old default'));
    off.enabled = false;
    const rows = sourceRows([keyRoot, alloc, mine, dead, off]);
    expect(rows.map((r) => [r.endpoint.name, r.type, r.flowpadAccount])).toEqual([
      ['my default', 'received', true],
      ['worker root', 'key', false],
      ['dead root', 'unfunded', false],
    ]);
  });
});

describe('costLeft / childrenOf', () => {
  it('read the hub facts', () => {
    expect(costLeft(key)).toMatchObject({ remaining: 6, limit: 10 });
    expect(childrenOf(org, [root, org, team, key]).map((e) => e.id)).toEqual([ID['team']]);
  });
});

describe('fundingPath / fundedBy / tightestLeft — full and narrowed chains', () => {
  const hop = (id: string, o: Record<string, unknown>) => ({ id, ...o }) as never;
  const day = { limit: 50, used: 0.29, remaining: 49.71, window: 'day', resets_at: 1793318400 };
  const total = { limit: 1000, used: 0.38, remaining: 999.62, window: 'total', resets_at: null };
  const full = {
    entry: { id: 'me', name: 'Eran' },
    hops: [
      hop('me', {
        name: 'Eran',
        source_kind: 'user',
        is_root: false,
        remaining: { cost_usd_per_day: day },
        limits: {},
      }),
      hop('team', {
        name: 'Dev Team budget',
        source_kind: 'team',
        scope_name: 'Dev Team',
        is_root: false,
        remaining: { cost_usd_total: total },
        limits: {},
      }),
      hop('org', {
        name: 'Langware budget',
        source_kind: 'organization',
        scope_name: 'Langware',
        is_root: true,
        provider: 'vertex',
        remaining: { cost_usd_total: { ...total, remaining: 20 } },
        limits: {},
      }),
    ],
    paths: [['me', 'team', 'org']],
    missing_sources: [],
    sticky_root_for_me: null,
  } as never;
  const narrowed = {
    entry: { id: 'me', name: 'Eran' },
    hops: [
      hop('me', {
        name: 'Eran',
        source_kind: 'user',
        is_root: false,
        remaining: { cost_usd_per_day: day },
        limits: {},
      }),
      hop('team', { source_kind: 'team', scope_name: 'Dev Team', is_root: false }),
    ],
    paths: [['me', 'team']],
    missing_sources: [],
    sticky_root_for_me: null,
  } as never;

  it('reads every level of a full chain, nearest first', () => {
    const path = fundingPath(full);
    expect(path.map((h) => [h.kind, h.name, h.redacted])).toEqual([
      ['me', 'Eran', false],
      ['team', 'Dev Team budget', false],
      ['org', 'Langware budget', false],
    ]);
    expect(funderName(fundedBy(path))).toBe('Dev Team');
    expect(hopCostLeft(path[1].hop)).toMatchObject({ key: 'cost_usd_total', remaining: 999.62 });
    expect(tightestLeft(path)).toBe(20);
  });

  it('a narrowed parent keeps its kind and team name; nothing above it, nothing to add up', () => {
    const path = fundingPath(narrowed);
    expect(path.map((h) => [h.kind, h.scopeName, h.redacted])).toEqual([
      ['me', null, false],
      ['team', 'Dev Team', true],
    ]);
    expect(funderName(fundedBy(path))).toBe('Dev Team');
    expect(hopCostLeft(path[1].hop)).toBeNull();
    expect(tightestLeft(path)).toBe(49.71);
  });

  it('a root or an unread chain has no funder', () => {
    expect(fundedBy(fundingPath(null))).toBeNull();
    expect(fundedBy(fundingPath({ ...(full as object), paths: [['org']] } as never))).toBeNull();
  });

  it('resetOf: the UTC time and hours left of a window; total windows never reset', () => {
    expect(resetOf(day, 1793318400 - 14 * 3600 + 60)).toEqual({ window: 'day', utc: '00:00', inHours: 14 });
    expect(resetOf(total)).toEqual({ window: 'total', utc: null, inHours: null });
    expect(resetOf(null)).toBeNull();
  });
});

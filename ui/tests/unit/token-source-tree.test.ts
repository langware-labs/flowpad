/** `buildSourceTree` — parents from the hub, depth-first, sponsor filter with dimmed ancestors. */
import { describe, expect, it } from 'vitest';

import { LLMEndpoint } from '@sdk';

import { FLOWPAD_ACCOUNT_ID, childrenOf, costLeft, sourceRows } from '@src/components/token-plan/source-tree';

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

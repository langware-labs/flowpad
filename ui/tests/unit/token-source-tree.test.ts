/** `buildSourceTree` — parents from the hub, depth-first, sponsor filter with dimmed ancestors. */
import { describe, expect, it } from 'vitest';

import { LLMEndpoint } from '@sdk';

import { buildSourceTree, childrenOf, costLeft, sponsorOf } from '@src/components/token-plan/source-tree';

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
const loose = ep(ID['loose'], [ID['not-visible']], 'user', 'Another key');

describe('buildSourceTree', () => {
  it('lays rows depth-first under their parent; an unseen parent makes a top-level row', () => {
    const rows = buildSourceTree([key, team, loose, org, root]);
    expect(rows.map((r) => [r.endpoint.id, r.depth])).toEqual([
      [ID['root'], 0],
      [ID['org'], 1],
      [ID['team'], 2],
      [ID['key'], 3],
      [ID['loose'], 0],
    ]);
    expect(rows.find((r) => r.endpoint.id === ID['team'])?.hasChildren).toBe(true);
  });

  it('a sponsor filter keeps the matches and their ancestors, dimmed', () => {
    const rows = buildSourceTree([root, org, team, key], 'team');
    expect(rows.map((r) => [r.endpoint.id, r.dimmed])).toEqual([
      [ID['root'], true],
      [ID['org'], true],
      [ID['team'], false],
    ]);
  });

  it('sponsor, cost left and children read the hub facts', () => {
    expect([root, org, team, key].map(sponsorOf)).toEqual(['shared', 'org', 'team', 'key']);
    expect(costLeft(key)).toMatchObject({ remaining: 6, limit: 10 });
    expect(childrenOf(org, [root, org, team, key]).map((e) => e.id)).toEqual([ID['team']]);
  });
});

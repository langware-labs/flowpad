/**
 * `buildChainTree`: paths → depth-first rows, first path emphasised, health
 * folded per hop, missing sources surfaced.
 */
import type { LLMChain, LLMChainHop } from '@sdk';
import { describe, expect, it } from 'vitest';

import { buildChainTree, consumerRows, consumersOf, hopHealth } from '@src/components/llm-endpoints/chain-tree';

const hop = (id: string, over: Partial<LLMChainHop> = {}): LLMChainHop => ({
  id,
  name: `n-${id}`,
  provider: null,
  is_root: false,
  has_credential: false,
  enabled: true,
  breaker: { state: 'closed', open_until: null },
  limits: {} as LLMChainHop['limits'],
  remaining: {},
  effective_filters: {} as LLMChainHop['effective_filters'],
  ...over,
});

// entry E → chain C → roots R1 (preferred), R2; E also → R3 directly.
const chain: LLMChain = {
  entry: { id: 'E', name: 'n-E' },
  hops: [
    hop('E'),
    hop('C'),
    hop('R1', { is_root: true, provider: 'anthropic', has_credential: true }),
    hop('R2', { is_root: true, provider: 'openai', has_credential: false }),
    hop('R3', {
      is_root: true,
      provider: 'openrouter',
      has_credential: true,
      breaker: { state: 'open', open_until: 1 },
    }),
  ],
  paths: [
    ['E', 'C', 'R1'],
    ['E', 'C', 'R2'],
    ['E', 'R3'],
  ],
  missing_sources: [],
  sticky_root_for_me: 'R1',
};

describe('buildChainTree', () => {
  it('lays the paths out depth-first, in fallback order', () => {
    const rows = buildChainTree(chain).map((n) => `${n.depth}:${n.id}`);
    expect(rows).toEqual(['0:E', '1:C', '2:R1', '2:R2', '1:R3']);
  });

  it('marks the first path and the sticky root', () => {
    const byId = Object.fromEntries(buildChainTree(chain).map((n) => [n.id, n]));
    expect(byId.E.isOnPath).toBe(true);
    expect(byId.C.isOnPath).toBe(true);
    expect(byId.R1.isOnPath).toBe(true);
    expect(byId.R2.isOnPath).toBe(false);
    expect(byId.R3.isOnPath).toBe(false);
    expect(byId.R1.isSticky).toBe(true);
    expect(byId.R2.pathIndexes).toEqual([1]);
    expect(byId.C.pathIndexes).toEqual([0, 1]);
  });

  it('gives each row its position under its parent (the fallback rank)', () => {
    const byId = Object.fromEntries(buildChainTree(chain).map((n) => [n.id, n]));
    expect(byId.R1.order).toBe(0);
    expect(byId.R2.order).toBe(1);
    expect(byId.C.order).toBe(0);
    expect(byId.R3.order).toBe(1);
  });

  it('folds health: ok / no key / breaker open / disabled / missing', () => {
    const byId = Object.fromEntries(buildChainTree(chain).map((n) => [n.id, n]));
    expect(byId.R1.health).toBe('ok');
    expect(byId.R2.health).toBe('no_credential');
    expect(byId.R3.health).toBe('breaker_open');
    expect(hopHealth(hop('x', { enabled: false, breaker: { state: 'open', open_until: 1 } }))).toBe('disabled');
    expect(hopHealth(null)).toBe('missing');
    // A chain hop without a credential is fine — only roots hold keys.
    expect(hopHealth(hop('c'))).toBe('ok');
  });

  it('a hop reachable two ways gets two rows with distinct keys', () => {
    const diamond: LLMChain = {
      ...chain,
      hops: [hop('E'), hop('A'), hop('B'), hop('R', { is_root: true, has_credential: true })],
      paths: [
        ['E', 'A', 'R'],
        ['E', 'B', 'R'],
      ],
      sticky_root_for_me: null,
    };
    const rows = buildChainTree(diamond);
    const rs = rows.filter((n) => n.id === 'R');
    expect(rs).toHaveLength(2);
    expect(new Set(rs.map((n) => n.key)).size).toBe(2);
  });

  it('surfaces missing sources as rows under the entry', () => {
    const rows = buildChainTree({ ...chain, paths: [['E']], hops: [hop('E')], missing_sources: ['llm_endpoint-gone'] });
    const missing = rows.find((n) => n.id === 'llm_endpoint-gone');
    expect(missing?.health).toBe('missing');
    expect(missing?.depth).toBe(1);
  });

  it('an entry with no paths still renders itself', () => {
    expect(buildChainTree({ ...chain, paths: [], hops: [hop('E')] }).map((n) => n.id)).toEqual(['E']);
    expect(buildChainTree(null)).toEqual([]);
  });
});

describe('consumersOf / consumerRows', () => {
  const ep = (id: string, sources: string[] = []) => ({ id, sources });
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const C = '00000000-0000-4000-8000-00000000000c';
  const D = '00000000-0000-4000-8000-00000000000d';
  const tid = (id: string) => `llm_endpoint-${id}`;
  // A ← B ← C, A ← D (B and D source from A; C sources from B).
  const all = [ep(A), ep(B, [tid(A)]), ep(C, [tid(B)]), ep(D, [tid(A), tid(B)])];

  it('finds the direct consumers by typeid, in list order', () => {
    expect(consumersOf(A, all).map((e) => e.id)).toEqual([B, D]);
    expect(consumersOf(B, all).map((e) => e.id)).toEqual([C, D]);
    expect(consumersOf(C, all)).toEqual([]);
  });

  it('walks consumers depth-first, listing an endpoint once at its first depth', () => {
    expect(consumerRows(A, all).map((r) => [r.endpoint.id, r.depth])).toEqual([
      [B, 0],
      [C, 1],
      [D, 1],
    ]);
  });

  it('a stale cycle terminates', () => {
    const cyc = [ep(A, [tid(B)]), ep(B, [tid(A)])];
    expect(consumerRows(A, cyc).map((r) => r.endpoint.id)).toEqual([B]);
  });
});

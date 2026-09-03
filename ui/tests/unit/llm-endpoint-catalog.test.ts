/**
 * The endpoint dialog's rules, without the dialog: root vs chain validation, and — the two that
 * matter most — the entity payload never carrying the key, and never carrying `sources`.
 *
 * That second one is a regression guard with a scar behind it. The hub removed the `sources` field
 * (it is a relationship now, written only by `allocate`) but an entity create DROPS unrecognised
 * fields and still answers 200, so a "create chain" came back green having made a keyless ROOT.
 * Nothing failed anywhere.
 *
 * The cycle tests are gone with `wouldCycle`. Cycles and narrowing are properties of the resolved
 * graph, and the client cannot see one any more — sources are edges the entity does not serialize,
 * so a client-side walk over the visible endpoints could only ever return false. The hub judges
 * them in `allocate`, against the source's own graph, before anything is written.
 */
import { LLMEndpoint } from '@sdk';
import { describe, expect, it } from 'vitest';

import {
  buildEntityJson,
  draftFrom,
  emptyDraft,
  endpointTypeId,
  PROVIDERS,
  providerSpec,
  buildAllocateBody,
  kindFromChain,
  validateDraft,
  withProvider,
  type EndpointDraft,
} from '@src/components/llm-endpoints/endpoint-catalog';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const messages = (problems: { message?: string }[]) => problems.map((p) => p.message);

describe('emptyDraft / withProvider', () => {
  it('starts as an OpenRouter root with the provider default base_url', () => {
    const d = emptyDraft();
    expect(d.kind).toBe('root');
    expect(d.provider).toBe('openrouter');
    expect(d.base_url).toBe(providerSpec('openrouter')?.defaultBaseUrl);
    expect(d.key).toBe('');
  });

  it('switching provider swaps in that provider default, but keeps a hand-edited URL', () => {
    const d = withProvider(emptyDraft(), 'anthropic');
    expect(d.base_url).toBe(PROVIDERS.find((p) => p.id === 'anthropic')?.defaultBaseUrl);
    const custom = withProvider({ ...emptyDraft(), base_url: 'https://proxy.example/v1' }, 'openai');
    expect(custom.base_url).toBe('https://proxy.example/v1');
  });
});

describe('validateDraft — root', () => {
  it('needs a name and an http(s) base_url', () => {
    const bad: EndpointDraft = { ...emptyDraft('root'), name: ' ', base_url: 'ftp://x' };
    const msgs = messages(validateDraft(bad, []));
    expect(msgs).toContain('Name is required.');
    expect(msgs).toContain('Base URL must be an http(s) URL.');
    expect(validateDraft({ ...emptyDraft('root'), name: 'r' }, [])).toEqual([]);
  });

  it('rejects negative filter ceilings and limits, and a bad streaming policy', () => {
    const d: EndpointDraft = {
      ...emptyDraft('root'),
      name: 'r',
      filters: { ...emptyDraft().filters, temperature_max: '-1', streaming: 'sometimes' as never },
      limits: { ...emptyDraft().limits, cost_usd_per_day: 'abc' },
    };
    const msgs = messages(validateDraft(d, []));
    expect(msgs).toContain('Filter ceilings must be non-negative numbers.');
    expect(msgs).toContain('Streaming must be allow, require or deny.');
    expect(msgs).toContain('Limits must be non-negative numbers.');
  });
});

describe('validateDraft — chain', () => {
  it('needs a parent to draw from', () => {
    expect(messages(validateDraft({ ...emptyDraft('chain'), name: 'c' }))).toContain(
      'Choose the endpoint this one draws from.',
    );
  });

  it('accepts a chain with a parent chosen', () => {
    const d: EndpointDraft = { ...emptyDraft('chain'), name: 'c', source: endpointTypeId(A) };
    expect(validateDraft(d)).toEqual([]);
  });

  it('does not ask an EDIT for a parent — it is fixed at allocation and never re-sent', () => {
    const d: EndpointDraft = { ...emptyDraft('chain'), id: B, name: 'c', source: '' };
    expect(validateDraft(d)).toEqual([]);
  });
});

describe('buildEntityJson', () => {
  it('never contains the key, on create or edit', () => {
    const d: EndpointDraft = { ...emptyDraft('root'), name: 'r', key: 'sk-secret-123' };
    for (const editing of [false, true]) {
      const json = buildEntityJson(d, editing);
      expect(JSON.stringify(json)).not.toContain('sk-secret-123');
      expect(json).not.toHaveProperty('key');
      expect(json).not.toHaveProperty('credential_hint');
    }
  });

  it('sends provider + base_url on create, omits them on edit (immutable)', () => {
    const d: EndpointDraft = { ...withProvider(emptyDraft('root'), 'anthropic'), name: 'r' };
    expect(buildEntityJson(d, false)).toMatchObject({
      name: 'r',
      enabled: true,
      provider: 'anthropic',
      base_url: 'https://api.anthropic.com',
    });
    const edited = buildEntityJson(d, true);
    expect(edited).not.toHaveProperty('provider');
    expect(edited).not.toHaveProperty('base_url');
  });

  it('never carries provider/base_url on a chain, and never carries sources at all', () => {
    // `sources` is the field the hub drops in silence — see the module note.
    const d: EndpointDraft = { ...emptyDraft('chain'), name: 'c', source: endpointTypeId(B) };
    const json = buildEntityJson(d, false);
    expect(json).not.toHaveProperty('provider');
    expect(json).not.toHaveProperty('base_url');
    expect(json).not.toHaveProperty('sources');
    expect(buildEntityJson({ ...emptyDraft('root'), name: 'r' }, false)).not.toHaveProperty('sources');
  });

  it('serialises filters and limits through the form round-trip', () => {
    const d: EndpointDraft = {
      ...emptyDraft('chain'),
      name: 'c',
      source: endpointTypeId(A),
      filters: { ...emptyDraft().filters, models_allow: 'a/*\n\nb/*', max_tokens_ceiling: '4096' },
      limits: { ...emptyDraft().limits, cost_usd_total: '5' },
    };
    const json = buildEntityJson(d, false) as { filters: Record<string, unknown>; limits: Record<string, unknown> };
    expect(json.filters.models_allow).toEqual(['a/*', 'b/*']);
    expect(json.filters.max_tokens_ceiling).toBe(4096);
    expect(json.filters.max_input_chars).toBeNull();
    expect(json.limits.cost_usd_total).toBe(5);
    expect(json.limits.tokens_total).toBeNull();
  });
});

describe('draftFrom', () => {
  it('reads an entity back into a draft with an empty key', () => {
    const e = new LLMEndpoint({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'root',
      provider: 'openai',
      base_url: 'https://api.openai.com',
      credential_hint: '****abcd',
      limits: { cost_usd_per_day: 2 },
    });
    const d = draftFrom(e);
    expect(d).toMatchObject({ id: e.id, kind: 'root', provider: 'openai', key: '' });
    expect(d.limits.cost_usd_per_day).toBe('2');
    expect(JSON.stringify(d)).not.toContain('****abcd');
  });

  it('a chain entity yields a chain draft carrying the parent it draws from', () => {
    const d = draftFrom(
      new LLMEndpoint({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'chain', sources: [endpointTypeId(A)] }),
    );
    expect(d.kind).toBe('chain');
    expect(d.source).toBe(endpointTypeId(A));
  });
});

describe('buildAllocateBody', () => {
  it('carries the child budget and NOT the parent — the parent is the URL', () => {
    const d: EndpointDraft = {
      ...emptyDraft('chain'),
      name: '  gadi+20 budget  ',
      source: endpointTypeId(A),
      filters: { ...emptyDraft().filters, models_allow: 'anthropic/claude-*' },
      limits: { ...emptyDraft().limits, cost_usd_total: '1' },
    };
    const body = buildAllocateBody(d);
    expect(body.name).toBe('gadi+20 budget');
    expect(body.filters.models_allow).toEqual(['anthropic/claude-*']);
    expect(body.limits.cost_usd_total).toBe(1);
    expect(body).not.toHaveProperty('source');
    expect(body).not.toHaveProperty('sources');
  });
});

describe('kindFromChain', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const chain = (isRoot: boolean) =>
    ({
      entry: { id: endpointTypeId(ID), name: 'x' },
      hops: [{ id: endpointTypeId(ID), is_root: isRoot }],
      paths: [],
      missing_sources: [],
      sticky_root_for_me: null,
    }) as never;

  it('reads the entry hop, because the entity cannot answer this at all', () => {
    // `LLMEndpoint.kind` is `sources.length ? 'chain' : 'root'`, and the hub does not serialize
    // `sources` — a source is an edge, deliberately not a client-writable field. So the entity says
    // `root` for EVERY endpoint, and a real chain is indistinguishable from a keyless orphan. Only
    // the chain report resolves the graph.
    expect(kindFromChain(chain(false), ID)).toBe('chain');
    expect(kindFromChain(chain(true), ID)).toBe('root');
  });

  it('answers null before the report arrives, rather than guessing', () => {
    // `root` is the wrong guess in exactly the case this exists to fix, so callers render nothing
    // until the answer is known instead of flashing a label that is wrong.
    expect(kindFromChain(undefined, ID)).toBeNull();
  });

  it('answers null when the entry is not among the hops', () => {
    const other = '22222222-2222-4222-8222-222222222222';
    expect(kindFromChain(chain(true), other)).toBeNull();
  });
});

describe('draftFrom', () => {
  it("takes the chain-resolved kind over the entity's own", () => {
    // The entity reports `root` for a chain, which opened the EDIT form with provider, base URL and
    // a key field — none of which a chain has.
    const chainEndpoint = new LLMEndpoint({ id: '33333333-3333-4333-8333-333333333333', name: 'c' });
    expect(chainEndpoint.kind).toBe('root');
    expect(draftFrom(chainEndpoint, 'chain').kind).toBe('chain');
  });

  it('falls back to the entity when the kind is not known yet', () => {
    const root = new LLMEndpoint({ id: '44444444-4444-4444-8444-444444444444', name: 'r' });
    expect(draftFrom(root, null).kind).toBe('root');
  });
});

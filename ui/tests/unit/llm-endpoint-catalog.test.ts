/**
 * The endpoint dialog's rules, without the dialog: root vs chain validation,
 * the cycle check, and — the one that matters most — the entity payload never
 * carrying the key and never re-sending the immutable root fields on edit.
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
  validateDraft,
  withProvider,
  wouldCycle,
  type EndpointDraft,
} from '@src/components/llm-endpoints/endpoint-catalog';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

// Plain rows, not entities: `validateDraft` only reads `id`/`sources`, and the
// SDK registers every constructed entity by typeid (a second construction of
// the same id logs a warning).
const ep = (id: string, sources: string[] = []) => ({ id, sources });

const ids = (problems: { id?: string }[]) => problems.map((p) => p.id);
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
  it('needs at least one source', () => {
    expect(messages(validateDraft({ ...emptyDraft('chain'), name: 'c' }, []))).toContain(
      'A chain needs at least one source.',
    );
  });

  it('accepts a chain over a root', () => {
    const d: EndpointDraft = { ...emptyDraft('chain'), name: 'c', sources: [endpointTypeId(A)] };
    expect(validateDraft(d, [ep(A)])).toEqual([]);
  });

  it('refuses sourcing itself', () => {
    const d: EndpointDraft = { ...emptyDraft('chain'), id: B, name: 'c', sources: [endpointTypeId(B)] };
    expect(messages(validateDraft(d, [ep(A), ep(B)]))).toContain('An endpoint cannot source itself.');
  });

  it('refuses a cycle through another endpoint (A→B, editing B to source A)', () => {
    // A already sources B; making B source A closes the loop.
    const all = [ep(A, [endpointTypeId(B)]), ep(B), ep(C)];
    expect(wouldCycle(endpointTypeId(B), [endpointTypeId(A)], all)).toBe(true);
    const d: EndpointDraft = { ...emptyDraft('chain'), id: B, name: 'b', sources: [endpointTypeId(A)] };
    expect(messages(validateDraft(d, all))).toContain('These sources would form a cycle.');
    // ...but B may source C, which is a root.
    expect(wouldCycle(endpointTypeId(B), [endpointTypeId(C)], all)).toBe(false);
  });

  it('a longer cycle (A→B→C, editing C to source A)', () => {
    const all = [ep(A, [endpointTypeId(B)]), ep(B, [endpointTypeId(C)]), ep(C)];
    expect(wouldCycle(endpointTypeId(C), [endpointTypeId(A)], all)).toBe(true);
  });

  it('a new (unsaved) chain has no self and cannot cycle', () => {
    const all = [ep(A, [endpointTypeId(B)]), ep(B)];
    expect(wouldCycle(undefined, [endpointTypeId(A)], all)).toBe(false);
  });

  it('flags a duplicated source', () => {
    const d: EndpointDraft = { ...emptyDraft('chain'), name: 'c', sources: [endpointTypeId(A), endpointTypeId(A)] };
    expect(ids(validateDraft(d, [ep(A)])).length).toBeGreaterThan(0);
    expect(messages(validateDraft(d, [ep(A)]))).toContain('Each source may appear once.');
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
      sources: [],
      provider: 'anthropic',
      base_url: 'https://api.anthropic.com',
    });
    const edited = buildEntityJson(d, true);
    expect(edited).not.toHaveProperty('provider');
    expect(edited).not.toHaveProperty('base_url');
  });

  it('a chain never carries provider/base_url and keeps source order', () => {
    const d: EndpointDraft = { ...emptyDraft('chain'), name: 'c', sources: [endpointTypeId(B), endpointTypeId(A)] };
    const json = buildEntityJson(d, false);
    expect(json).not.toHaveProperty('provider');
    expect(json.sources).toEqual([endpointTypeId(B), endpointTypeId(A)]);
  });

  it('serialises filters and limits through the form round-trip', () => {
    const d: EndpointDraft = {
      ...emptyDraft('chain'),
      name: 'c',
      sources: [endpointTypeId(A)],
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

  it('a chain entity yields a chain draft with its sources', () => {
    const d = draftFrom(
      new LLMEndpoint({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'chain', sources: [endpointTypeId(A)] }),
    );
    expect(d.kind).toBe('chain');
    expect(d.sources).toEqual([endpointTypeId(A)]);
  });
});

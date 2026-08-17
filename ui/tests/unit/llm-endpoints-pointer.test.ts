/**
 * The LLM endpoints pointer grammar: `[<id>[/<tab>]]`, and the typeid helpers
 * the harness modal + sources picker share.
 */
import { describe, expect, it } from 'vitest';

import {
  endpointIdFromTypeId,
  endpointTypeId,
  llmEndpointsPointer,
  parseLlmEndpointsPointer,
} from '@src/components/llm-endpoints/llm-endpoints-pointer';

const ID = '550e8400-e29b-41d4-a716-446655440000';

describe('parseLlmEndpointsPointer', () => {
  it('empty → list, overview', () => {
    expect(parseLlmEndpointsPointer(undefined)).toEqual({ id: undefined, tab: 'overview' });
    expect(parseLlmEndpointsPointer('')).toEqual({ id: undefined, tab: 'overview' });
  });

  it('id alone → overview', () => {
    expect(parseLlmEndpointsPointer(ID)).toEqual({ id: ID, tab: 'overview' });
  });

  it('id + known tab', () => {
    expect(parseLlmEndpointsPointer(`${ID}/usage`)).toEqual({ id: ID, tab: 'usage' });
    expect(parseLlmEndpointsPointer(`${ID}/models`)).toEqual({ id: ID, tab: 'models' });
  });

  it('unknown tab falls back to overview', () => {
    expect(parseLlmEndpointsPointer(`${ID}/nope`).tab).toBe('overview');
  });

  it('a typeid in the URL resolves to the bare id (hop ids and sources are typeids)', () => {
    expect(parseLlmEndpointsPointer(`llm_endpoint-${ID}/usage`)).toEqual({ id: ID, tab: 'usage' });
    expect(llmEndpointsPointer(`llm_endpoint-${ID}`, 'models')).toBe(`${ID}/models`);
  });
});

describe('llmEndpointsPointer', () => {
  it('round-trips with the parser', () => {
    for (const tab of ['overview', 'usage', 'models'] as const) {
      expect(parseLlmEndpointsPointer(llmEndpointsPointer(ID, tab))).toEqual({ id: ID, tab });
    }
  });

  it('omits the default tab and yields the empty pointer without an id', () => {
    expect(llmEndpointsPointer(ID, 'overview')).toBe(ID);
    expect(llmEndpointsPointer(undefined, 'usage')).toBe('');
  });
});

describe('typeid helpers', () => {
  it('build and strip the llm_endpoint- prefix, tolerating the colon spelling', () => {
    expect(endpointTypeId(ID)).toBe(`llm_endpoint-${ID}`);
    expect(endpointIdFromTypeId(`llm_endpoint-${ID}`)).toBe(ID);
    expect(endpointIdFromTypeId(`llm_endpoint:${ID}`)).toBe(ID);
    expect(endpointIdFromTypeId(ID)).toBe(ID);
  });
});

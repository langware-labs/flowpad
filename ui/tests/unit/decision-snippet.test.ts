/**
 * `docs/snippets/decisions.md` §6, the TypeScript fence, run as written.
 *
 * The real `@sdk/decision` — only `apiClient` is answered, by a double that plays the desk's
 * `compute_node/@local/decision` route and checks each request: the path, the verb, the body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@sdk/client', () => ({ default: client }));

import { DecisionError, decide, decisionEndpoints, pick } from '@sdk/decision';
import { runTsFence, snippetDoc, tsFenceUnder } from '../utils/ts-snippets';

const BASE = '/api/v1/graph/compute_node/@local/decision';
const JEV = {
  id: '72575461-9352-4cdb-b2e7-a53be3e3d6e3',
  name: 'Jev',
  kinds: ['decision'],
  enabled: true,
  host: 'api.typesafe.ai',
};

describe('decisions — the TypeScript fence', () => {
  afterEach(() => vi.clearAllMocks());

  it('runs as written: list, decide, pick', async () => {
    client.get.mockResolvedValue([JEV]);
    client.post.mockImplementation((path: string, body: { spec: { questions: Record<string, unknown> } }) => {
      expect(path).toBe(BASE);
      expect(Object.keys(body.spec.questions)).toEqual(['target']);
      return Promise.resolve({
        answers: { target: { type: 'choice', choice: 'view:data-sources', confidence: 0.97, probabilities: {} } },
        model: 'jev-1.13.0',
        usage: { input_tokens: 300, output_tokens: 0 },
        latency_ms: 290,
        endpoint: `api_endpoint-${JEV.id}`,
      });
    });

    const ns = await runTsFence(tsFenceUnder(snippetDoc('decisions.md'), '6.'), { decide, decisionEndpoints, pick });

    expect(client.get).toHaveBeenCalledWith(`${BASE}/endpoints`);
    expect(ns.deciders).toEqual([JEV]);
    expect(ns.target).toBe('view:data-sources');
  });

  it('is not sure below the bar, and a refusal is one closed reason', async () => {
    const unsure = {
      answers: { target: { type: 'choice' as const, choice: 'x', confidence: 0.84, probabilities: {} } },
      model: '',
      usage: { input_tokens: 0, output_tokens: 0 },
      latency_ms: 0,
      endpoint: '',
    };
    expect(pick(unsure, 'target', { min: 0.85 })).toBeNull();
    expect(pick(unsure, 'missing')).toBeNull();

    client.post.mockRejectedValue({
      response: { status: 404, data: { message: 'none marked', data: { reason: 'no_endpoint' } } },
    });
    const failed = await decide({ state: 'x', questions: {} }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(DecisionError);
    expect((failed as DecisionError).reason).toBe('no_endpoint');
  });
});

/**
 * Take a decision through the hub APIEndpoint marked `decision`.
 *
 *     const result = await decide(spec);
 *     pick(result, 'target', { min: 0.85 });   // the option, or null when not sure
 *
 * The box finds the endpoint by what it IS (`kinds` contains `'decision'`), the way it lists
 * LLM endpoints, and adds its own hub login — the browser holds neither a hub key nor the
 * vendor's. Everything goes through `apiClient` with a PATH; its interceptor has already
 * unwrapped the envelope, so what arrives IS the `DecisionResult`.
 *
 * A decision is an optimisation, never a dependency: every failure is a `DecisionError` with a
 * closed `reason`, and a caller that cannot get one takes the ordinary path.
 */

import apiClient from '../client';
import type { APIEndpointOffer, DecisionFailure, DecisionResult, DecisionSpec } from './types';

const BASE = '/api/v1/graph/compute_node/@local/decision';
const REASONS: ReadonlySet<DecisionFailure> = new Set<DecisionFailure>([
  'invalid_spec',
  'no_endpoint',
  'rate_limited',
  'billing',
  'unavailable',
  'auth',
  'bad_response',
]);

export class DecisionError extends Error {
  constructor(
    readonly reason: DecisionFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DecisionError';
  }
}

interface FailedCall {
  response?: { status?: number; data?: { message?: string; data?: { reason?: string } } };
  message?: string;
}

function asDecisionError(error: unknown): DecisionError {
  const failed = error as FailedCall;
  const reason = failed?.response?.data?.data?.reason as DecisionFailure | undefined;
  const message = failed?.response?.data?.message || failed?.message || 'decision failed';
  return new DecisionError(reason && REASONS.has(reason) ? reason : 'unavailable', message);
}

/** One decision. `endpoint` (an id or `api_endpoint-<id>`) names one instead of finding it by kind. */
export async function decide(spec: DecisionSpec, options: { endpoint?: string } = {}): Promise<DecisionResult> {
  try {
    return await apiClient.post<DecisionResult>(BASE, { spec, endpoint: options.endpoint ?? null });
  } catch (error) {
    throw asDecisionError(error);
  }
}

/** The hub decision APIs this user may call; `[]` when signed out or the hub is unreachable. */
export async function decisionEndpoints(): Promise<APIEndpointOffer[]> {
  return (await apiClient.get<APIEndpointOffer[]>(`${BASE}/endpoints`)) ?? [];
}

/**
 * The chosen option of choice question `name` when its confidence is at least `min`, else
 * `null` — missing, unsure, or not a choice. Not being sure is an answer: fall back, don't act.
 */
export function pick(result: DecisionResult, name: string, options: { min?: number } = {}): string | null {
  const answer = result.answers[name];
  if (!answer || answer.type !== 'choice' || answer.confidence < (options.min ?? 0)) return null;
  return answer.choice;
}

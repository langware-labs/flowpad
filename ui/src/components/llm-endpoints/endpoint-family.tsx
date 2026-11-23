/**
 * The two endpoint families one screen shows: LLM endpoints and API endpoints (pictures, video, any
 * cloud API). Both are budgets on the hub with the same chain, limits, usage and credential, so every
 * component here serves both; a family is the short list of what differs — which hub type and
 * service, which limits exist, which usage breakdowns, which third tab.
 *
 * Components read the family from context (`useEndpointFamily`). Outside a provider it is the LLM
 * family, so every screen that embeds one of these components keeps its behaviour.
 */
import { APIEndpoint, LLMEndpoint, apiEndpointsService, llmEndpointsService, type LLMUsageBy } from '@sdk';
import { createContext, useContext } from 'react';

import { API_LIMIT_KEYS, LIMIT_KEYS, type AnyLimitKey } from './filters-limits-forms';
import type { EndpointFamilyId, LlmEndpointTab } from './llm-endpoints-pointer';

export interface LimitGroup {
  keys: readonly AnyLimitKey[];
  step: string;
}

export interface EndpointFamily {
  id: EndpointFamilyId;
  /** The hub entity type (`llm_endpoint` | `api_endpoint`). */
  type: string;
  /** The SDK class a row of this family is. */
  Entity: typeof LLMEndpoint;
  service: typeof llmEndpointsService;
  /** First element of every react-query key of this family. */
  queryKey: string;
  /** Tokens, models and model sizes exist (LLM only). */
  llm: boolean;
  limitKeys: readonly AnyLimitKey[];
  /** The limits editor's rows, in order. */
  limitGroups: readonly LimitGroup[];
  /** The usage breakdowns, in toggle order. */
  usageBy: readonly LLMUsageBy[];
  tabs: readonly LlmEndpointTab[];
}

const COST: LimitGroup = {
  keys: ['cost_usd_total', 'cost_usd_per_day', 'cost_usd_per_week', 'cost_usd_per_month'],
  step: '0.01',
};

export const LLM_FAMILY: EndpointFamily = {
  id: 'llm',
  type: LLMEndpoint.type,
  Entity: LLMEndpoint,
  service: llmEndpointsService,
  queryKey: 'llm-endpoint',
  llm: true,
  limitKeys: LIMIT_KEYS,
  limitGroups: [
    { keys: ['tokens_total', 'tokens_per_day', 'tokens_per_week', 'tokens_per_month'], step: '1' },
    COST,
    { keys: ['requests_per_minute'], step: '1' },
  ],
  usageBy: ['child', 'model'],
  tabs: ['overview', 'usage', 'models'],
};

export const API_FAMILY: EndpointFamily = {
  id: 'api',
  type: APIEndpoint.type,
  Entity: APIEndpoint,
  service: apiEndpointsService,
  queryKey: 'api-endpoint',
  llm: false,
  limitKeys: API_LIMIT_KEYS,
  limitGroups: [
    COST,
    { keys: ['requests_total', 'requests_per_day', 'requests_per_week', 'requests_per_month'], step: '1' },
    { keys: ['requests_per_minute'], step: '1' },
  ],
  usageBy: ['child', 'caller'],
  tabs: ['overview', 'usage', 'prices'],
};

export function endpointFamily(id: EndpointFamilyId): EndpointFamily {
  return id === 'api' ? API_FAMILY : LLM_FAMILY;
}

const EndpointFamilyContext = createContext<EndpointFamily>(LLM_FAMILY);

export const EndpointFamilyProvider = EndpointFamilyContext.Provider;

export function useEndpointFamily(): EndpointFamily {
  return useContext(EndpointFamilyContext);
}

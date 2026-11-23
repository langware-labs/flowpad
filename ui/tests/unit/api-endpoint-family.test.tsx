/**
 * The Cloud APIs side of the endpoints screen: the same components as an LLM endpoint, fed the API
 * family. Covers what differs — the pointer (`api/<id>/<tab>`), the entity, the dialog's JSON, the
 * limits, and the usage table without token columns.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ openPage: vi.fn() }));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openPage: h.openPage }, currentDock: { page: 'hub' } }),
}));

import { APIEndpoint, LLMEndpoint, PageId, ViewType, apiEndpointsService, type LLMUsageCounters } from '@sdk';

import {
  apiEndpointDraftFrom,
  buildApiAllocateBody,
  buildApiEntityJson,
  emptyApiEndpointDraft,
  priceRules,
  validateApiEndpointDraft,
} from '@src/components/llm-endpoints/api-endpoint-draft';
import { API_FAMILY, EndpointFamilyProvider, LLM_FAMILY } from '@src/components/llm-endpoints/endpoint-family';
import { kindFromChain } from '@src/components/llm-endpoints/endpoint-catalog';
import { API_LIMIT_KEYS, formToLimits, limitsToForm } from '@src/components/llm-endpoints/filters-limits-forms';
import {
  familyOfTypeId,
  llmEndpointsPointer,
  parseEndpointsPointer,
} from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { LimitsEditor } from '@src/components/llm-endpoints/LimitsEditor';
import { priceText } from '@src/components/llm-endpoints/PricesList';
import { UsageByChildTable } from '@src/components/llm-endpoints/UsageByChildTable';
import { ZERO_COUNTERS } from '@src/components/llm-endpoints/usage-math';

const ID = '550e8400-e29b-41d4-a716-446655440000';
const c = (over: Partial<LLMUsageCounters>): LLMUsageCounters => ({ ...ZERO_COUNTERS, ...over });

describe('the pointer', () => {
  it('reads `api/…` as the Cloud APIs side and anything else as LLM', () => {
    expect(parseEndpointsPointer('api')).toEqual({ family: 'api', id: undefined, tab: 'overview' });
    expect(parseEndpointsPointer(`api/${ID}/prices`)).toEqual({ family: 'api', id: ID, tab: 'prices' });
    expect(parseEndpointsPointer(`api/api_endpoint-${ID}/usage`)).toEqual({ family: 'api', id: ID, tab: 'usage' });
    expect(parseEndpointsPointer(`${ID}/usage`)).toEqual({ family: 'llm', id: ID, tab: 'usage' });
    expect(parseEndpointsPointer('')).toEqual({ family: 'llm', id: undefined, tab: 'overview' });
  });

  it('round-trips with the family', () => {
    expect(llmEndpointsPointer(undefined, undefined, 'api')).toBe('api');
    expect(llmEndpointsPointer(ID, 'usage', 'api')).toBe(`api/${ID}/usage`);
    expect(llmEndpointsPointer(ID, 'overview', 'api')).toBe(`api/${ID}`);
    expect(familyOfTypeId(`api_endpoint-${ID}`)).toBe('api');
    expect(familyOfTypeId(`llm_endpoint-${ID}`)).toBe('llm');
  });
});

describe('the family', () => {
  it('names the hub type, its service and what differs', () => {
    expect(API_FAMILY.type).toBe('api_endpoint');
    expect(API_FAMILY.service).toBe(apiEndpointsService);
    expect(apiEndpointsService.type).toBe('api_endpoint');
    expect(API_FAMILY.tabs).toEqual(['overview', 'usage', 'prices']);
    expect(API_FAMILY.usageBy).toEqual(['child', 'caller']);
    expect(API_FAMILY.limitGroups.flatMap((g) => g.keys)).toEqual([...API_LIMIT_KEYS]);
    expect(LLM_FAMILY.tabs).toEqual(['overview', 'usage', 'models']);
  });
});

describe('APIEndpoint', () => {
  it('is an endpoint row with its own type, parents and fields', () => {
    const row = new APIEndpoint({
      id: ID,
      name: 'video',
      kinds: ['video.generate'],
      target: { base_url: 'https://v.example/v1', inject: { header: 'x-key', format: '{value}' } },
      limits: { cost_usd_total: 6 },
    });
    expect(row.getType()).toBe('api_endpoint');
    expect(row).toBeInstanceOf(LLMEndpoint);
    expect(row.base_url).toBe('https://v.example/v1');
    expect(row.apiLimits).toMatchObject({ cost_usd_total: 6, requests_per_day: null });
    expect('tokens_total' in row.limits).toBe(false);
    const child = new APIEndpoint({
      id: '660e8400-e29b-41d4-a716-446655440000',
      expand: { source_ids: [`api_endpoint-${ID}`] },
    } as never);
    expect(child.parentIds).toEqual([ID]);
    expect(child.kind).toBe('chain');
  });

  it('finds its hop in a chain whose ids are api_endpoint typeids', () => {
    const chain = { hops: [{ id: `api_endpoint-${ID}`, is_root: true }] } as never;
    expect(kindFromChain(chain, ID)).toBe('root');
  });
});

describe('the dialog draft', () => {
  it('builds a new root: target and where the key goes, kinds, prices — never the key', () => {
    const draft = emptyApiEndpointDraft('root');
    draft.name = ' Veo ';
    draft.base_url = 'https://v.example/v1';
    draft.key = 'secret';
    draft.limits.cost_usd_per_month = '150';
    draft.api = {
      ...draft.api!,
      kinds: 'video.generate',
      header: 'X-Goog-Api-Key',
      format: '{value}',
      prices: [
        {
          path: 'models/veo:predictLongRunning',
          usd: '0.10',
          times: 'parameters.durationSeconds=8, parameters.sampleCount',
        },
        { path: '', usd: '', times: '' },
      ],
      paths: 'models/veo:*\n',
    };
    expect(validateApiEndpointDraft(draft)).toEqual([]);
    const json = buildApiEntityJson(draft, false);
    expect(json).toEqual({
      name: 'Veo',
      enabled: true,
      filters: { paths_allow: ['models/veo:*'], methods_allow: [] },
      limits: expect.objectContaining({ cost_usd_per_month: 150, requests_per_day: null }),
      kinds: ['video.generate'],
      meter: {
        kind: 'per_call',
        rules: [
          {
            path: 'models/veo:predictLongRunning',
            usd: 0.1,
            times: [{ field: 'parameters.durationSeconds', default: 8 }, { field: 'parameters.sampleCount' }],
          },
        ],
      },
      target: { base_url: 'https://v.example/v1', inject: { header: 'x-goog-api-key', format: '{value}' } },
    });
    expect(JSON.stringify(json)).not.toContain('secret');
    expect('tokens_total' in (json.limits as object)).toBe(false);
  });

  it('never re-sends the target on edit, and an allocation carries no root fields', () => {
    const entity = new APIEndpoint({
      id: ID,
      name: 'Veo',
      kinds: ['video.generate'],
      target: { base_url: 'https://v.example/v1', inject: { header: 'x-key', format: 'Bearer {value}' } },
      meter: { kind: 'per_call', rules: [{ path: 'a/b', usd: 0.034 }] },
      filters: { paths_allow: ['a/*'], methods_allow: ['POST'] },
      limits: { cost_usd_total: 6, requests_per_day: 300 },
    });
    const draft = apiEndpointDraftFrom(entity, 'root');
    expect(draft.api).toMatchObject({
      kinds: 'video.generate',
      header: 'x-key',
      format: 'Bearer {value}',
      paths: 'a/*',
    });
    expect(draft.limits.cost_usd_total).toBe('6');
    const json = buildApiEntityJson(draft, true);
    expect(json.target).toBeUndefined();
    expect(json.meter).toEqual({ kind: 'per_call', rules: [{ path: 'a/b', usd: 0.034, times: [] }] });

    const child = { ...emptyApiEndpointDraft('chain'), name: 'student', source: `api_endpoint-${ID}` };
    child.limits.cost_usd_total = '6';
    expect(validateApiEndpointDraft(child)).toEqual([]);
    expect(buildApiAllocateBody(child)).toEqual({
      name: 'student',
      filters: { paths_allow: [], methods_allow: [] },
      limits: expect.objectContaining({ cost_usd_total: 6 }),
    });
    expect(buildApiEntityJson(child, false)).not.toHaveProperty('kinds');
  });

  it('leaves a token-priced meter as the hub holds it', () => {
    const draft = emptyApiEndpointDraft('root');
    draft.api = { ...draft.api!, meterKind: 'json_usage' };
    expect(buildApiEntityJson(draft, true)).not.toHaveProperty('meter');
  });

  it('refuses what the hub would: http, no header, a bad price', () => {
    const draft = emptyApiEndpointDraft('root');
    draft.base_url = 'http://v.example';
    draft.api = { ...draft.api!, header: '', prices: [{ path: 'a', usd: '-1', times: '' }] };
    expect(validateApiEndpointDraft(draft)).toHaveLength(3);
    expect(priceRules([{ path: ' ', usd: '1', times: '' }])).toEqual([]);
  });

  it('round-trips the API limits and says a price in words', () => {
    const form = limitsToForm({ cost_usd_total: 6, requests_per_day: 300 }, API_LIMIT_KEYS);
    expect(form.requests_per_day).toBe('300');
    expect(formToLimits(form, API_LIMIT_KEYS)).toMatchObject({ cost_usd_total: 6, requests_per_day: 300 });
    expect(priceText({ path: 'a', usd: 0.1, times: [{ field: 'parameters.durationSeconds' }] }, 'free')).toBe(
      '$0.100 × parameters.durationSeconds',
    );
    expect(priceText({ path: 'a', usd: 0 }, 'free')).toBe('free');
  });
});

describe('the shared components, on the API family', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('LimitsEditor offers dollars and requests, no tokens', () => {
    render(
      <EndpointFamilyProvider value={API_FAMILY}>
        <LimitsEditor value={limitsToForm(null, API_LIMIT_KEYS)} onChange={() => {}} />
      </EndpointFamilyProvider>,
    );
    expect(screen.getByLabelText('Cost (USD), total')).toBeTruthy();
    expect(screen.getByLabelText('Requests / day')).toBeTruthy();
    expect(screen.queryByLabelText('Tokens, total')).toBeNull();
  });

  it('the usage table shows refused calls, no tokens, and drills into the API side', async () => {
    render(
      <EndpointFamilyProvider value={API_FAMILY}>
        <UsageByChildTable
          by="child"
          breakdown={{ [`api_endpoint-${ID}`]: c({ requests: 2, refusals: 1, cost_usd: 0.068, total_tokens: 9 }) }}
          names={{ [`api_endpoint-${ID}`]: 'student 12' }}
          all={[]}
        />
      </EndpointFamilyProvider>,
    );
    expect(screen.getByText('Refused')).toBeTruthy();
    expect(screen.queryByText('Tokens')).toBeNull();
    expect(screen.queryByText('Fallbacks')).toBeNull();
    const row = screen.getByTestId(`usage-row-api_endpoint-${ID}`);
    expect(row.textContent).toBe('student 12201$0.068');
    await userEvent.click(row);
    expect(h.openPage).toHaveBeenCalledWith(PageId.HUB, ViewType.LLM_ENDPOINTS, `api/${ID}/usage`);
  });
});

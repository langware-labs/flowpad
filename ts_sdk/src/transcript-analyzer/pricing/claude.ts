/**
 * Claude price tables — mirrors
 * flow_sdk/transcript_analyzer/pricing/claude.py.
 *
 * Rates per 1M tokens / per 1K requests for server tools.
 * Cache write 5m: 1.25× input; 1h: 2× input. Cache read: 0.1× input.
 */

import { ItemPrice, ModelPricing } from './base';

const M = 1_000_000;

function claudePricing(model: string, baseIn: number, baseOut: number): ModelPricing {
  const items: ItemPrice[] = [
    // Cache read first — more specific than bare input.
    { dims: { io: 'input', cache: 'read' }, perUnitUsd: (baseIn * 0.10) / M },
    { dims: { io: 'input', cache: 'write', cache_tier: '5m' }, perUnitUsd: (baseIn * 1.25) / M },
    { dims: { io: 'input', cache: 'write', cache_tier: '1h' }, perUnitUsd: (baseIn * 2.0) / M },
    { dims: { io: 'input', cache: 'none' }, perUnitUsd: baseIn / M },
    { dims: { io: 'output' }, perUnitUsd: baseOut / M },
    { dims: { unit: 'request', tool: 'web_search' }, perUnitUsd: 10.0 / 1000 },
    { dims: { unit: 'request', tool: 'web_fetch' }, perUnitUsd: 5.0 / 1000 },
  ];
  return new ModelPricing(model, items);
}

export const SONNET_4 = claudePricing('claude-sonnet-4', 3.0, 15.0);
export const OPUS_4 = claudePricing('claude-opus-4', 5.0, 25.0);
export const HAIKU_4 = claudePricing('claude-haiku-4', 1.0, 5.0);
export const SONNET_3_5 = claudePricing('claude-3-5-sonnet', 3.0, 15.0);
export const OPUS_3 = claudePricing('claude-3-opus', 15.0, 75.0);
export const HAIKU_3 = claudePricing('claude-3-haiku', 0.25, 1.25);

export const CLAUDE_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-6': SONNET_4,
  'claude-sonnet-4-7': SONNET_4,
  'claude-sonnet-4-5': SONNET_4,
  'claude-sonnet-4-5-20250929': SONNET_4,
  'claude-opus-4-6': OPUS_4,
  'claude-opus-4-7': OPUS_4,
  'claude-opus-4-5': OPUS_4,
  'claude-opus-4-5-20251101': OPUS_4,
  'claude-haiku-4-5': HAIKU_4,
  'claude-haiku-4-5-20251001': HAIKU_4,
  'claude-3-5-sonnet': SONNET_3_5,
  'claude-3-5-sonnet-20241022': SONNET_3_5,
  'claude-3-opus': OPUS_3,
  'claude-3-haiku': HAIKU_3,
};

const _DEFAULT = SONNET_4;

export function pricingFor(model: string | null | undefined): ModelPricing {
  if (!model) return _DEFAULT;
  if (model in CLAUDE_PRICING) return CLAUDE_PRICING[model];
  for (const [key, table] of Object.entries(CLAUDE_PRICING)) {
    if (key.includes(model) || model.includes(key)) return table;
  }
  return _DEFAULT;
}

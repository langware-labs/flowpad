/**
 * Per-worker pricing for transcript usage entries.
 *
 * Mirrors flow_sdk/transcript_analyzer/pricing/__init__.py: one entry per
 * worker, top-level `pricingFor` dispatches by model name prefix.
 */

export type { ItemPrice } from './base';
export { ModelPricing } from './base';
export { CLAUDE_PRICING, pricingFor as claudePricingFor } from './claude';

import type { ModelPricing } from './base';
import { pricingFor as _claudeFor } from './claude';

export function pricingFor(model: string | null | undefined, worker?: string | null): ModelPricing {
  if (worker === 'claude' || (model && model.startsWith('claude'))) {
    return _claudeFor(model);
  }
  // Codex skeleton lives in pricing/codex on the Python side; for the UI
  // demo we only need Claude. Fall back to the Claude default.
  return _claudeFor(model);
}

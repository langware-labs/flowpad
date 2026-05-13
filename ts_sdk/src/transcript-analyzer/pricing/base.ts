/**
 * ItemPrice / ModelPricing — TS mirror of
 * flow_sdk/transcript_analyzer/pricing/base.py.
 *
 * One rule per chargeable stream; first-match-wins. Dims are matched against
 * UsageEntry by attribute equality — keys absent from `dims` are wildcards.
 */

import type { UsageEntry } from '../entries/usage';

export interface ItemPrice {
  /** Dimension match against UsageEntry. Missing key = wildcard. */
  dims: Record<string, unknown>;
  /** USD per single unit (token or request). */
  perUnitUsd: number;
}

export class ModelPricing {
  constructor(public model: string, public items: ItemPrice[]) {}

  costOf(entry: UsageEntry): number {
    for (const rule of this.items) {
      if (this._matches(rule, entry)) {
        return entry.count * rule.perUnitUsd;
      }
    }
    return 0;
  }

  cost(entries: Iterable<UsageEntry>): number {
    let total = 0;
    for (const e of entries) total += this.costOf(e);
    return total;
  }

  private _matches(rule: ItemPrice, entry: UsageEntry): boolean {
    for (const [k, expected] of Object.entries(rule.dims)) {
      const actual = (entry as unknown as Record<string, unknown>)[k];
      if (actual !== expected) return false;
    }
    return true;
  }
}

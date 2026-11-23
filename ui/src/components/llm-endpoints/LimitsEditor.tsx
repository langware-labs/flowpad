/**
 * The optimistic limits of an endpoint. Empty = no limit. Grouped as the hub
 * groups them: tokens by window, cost by window, then the per-minute rate. The rows are the
 * endpoint family's (`endpoint-family`): an API endpoint has requests per window and no tokens.
 */
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';

import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';

import { useEndpointFamily } from './endpoint-family';
import type { AnyLimitKey, LimitKey, LimitsForm } from './filters-limits-forms';

export const LIMIT_LABELS: Record<AnyLimitKey, MessageDescriptor> = {
  tokens_total: msg`Tokens, total`,
  tokens_per_day: msg`Tokens / day`,
  tokens_per_week: msg`Tokens / week`,
  tokens_per_month: msg`Tokens / month`,
  cost_usd_total: msg`Cost (USD), total`,
  cost_usd_per_day: msg`Cost (USD) / day`,
  cost_usd_per_week: msg`Cost (USD) / week`,
  cost_usd_per_month: msg`Cost (USD) / month`,
  requests_per_minute: msg`Requests / minute`,
  requests_total: msg`Requests, total`,
  requests_per_day: msg`Requests / day`,
  requests_per_week: msg`Requests / week`,
  requests_per_month: msg`Requests / month`,
};

export interface LimitsEditorProps {
  value: LimitsForm;
  onChange: (next: LimitsForm) => void;
  disabled?: boolean;
  /** Limits the surrounding screen already edits itself. The budgets page puts `cost_usd_total`
   *  on the row as a money box, so its "Advanced" dialog hides it here rather than offering the
   *  same number twice, in two shapes, with no clue which one wins. */
  omit?: readonly LimitKey[];
}

export function LimitsEditor({ value, onChange, disabled, omit }: LimitsEditorProps) {
  const { t } = useLingui();
  const hidden = new Set<AnyLimitKey>(omit ?? []);
  const groups = useEndpointFamily()
    .limitGroups.map((g) => ({ ...g, keys: g.keys.filter((k) => !hidden.has(k)) }))
    .filter((g) => g.keys.length > 0);
  return (
    <div className="space-y-3" data-testid="limits-editor">
      {groups.map((group) => (
        <div key={group.keys[0]} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {group.keys.map((key) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`llm-l-${key}`}>{t(LIMIT_LABELS[key])}</Label>
              <Input
                id={`llm-l-${key}`}
                type="number"
                min={0}
                step={group.step}
                inputMode="decimal"
                value={value[key] ?? ''}
                disabled={disabled}
                placeholder={t`unlimited`}
                onChange={(e) => onChange({ ...value, [key]: e.target.value })}
              />
            </div>
          ))}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        <Trans>Limits are optimistic: usage already in flight can overshoot slightly. Windows are UTC.</Trans>
      </p>
    </div>
  );
}

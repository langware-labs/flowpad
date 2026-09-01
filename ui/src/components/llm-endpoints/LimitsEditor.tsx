/**
 * The optimistic limits of an endpoint. Empty = no limit. Grouped as the hub
 * groups them: tokens by window, cost by window, then the per-minute rate.
 */
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Trans, useLingui } from '@lingui/react/macro';

import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';

import type { LimitKey, LimitsForm } from './filters-limits-forms';

export const LIMIT_LABELS: Record<LimitKey, MessageDescriptor> = {
  tokens_total: msg`Tokens, total`,
  tokens_per_day: msg`Tokens / day`,
  tokens_per_week: msg`Tokens / week`,
  tokens_per_month: msg`Tokens / month`,
  cost_usd_total: msg`Cost (USD), total`,
  cost_usd_per_day: msg`Cost (USD) / day`,
  cost_usd_per_week: msg`Cost (USD) / week`,
  cost_usd_per_month: msg`Cost (USD) / month`,
  requests_per_minute: msg`Requests / minute`,
};

const GROUPS: { keys: LimitKey[]; step: string }[] = [
  { keys: ['tokens_total', 'tokens_per_day', 'tokens_per_week', 'tokens_per_month'], step: '1' },
  { keys: ['cost_usd_total', 'cost_usd_per_day', 'cost_usd_per_week', 'cost_usd_per_month'], step: '0.01' },
  { keys: ['requests_per_minute'], step: '1' },
];

export interface LimitsEditorProps {
  value: LimitsForm;
  onChange: (next: LimitsForm) => void;
  disabled?: boolean;
}

export function LimitsEditor({ value, onChange, disabled }: LimitsEditorProps) {
  const { t } = useLingui();
  return (
    <div className="space-y-3" data-testid="limits-editor">
      {GROUPS.map((group) => (
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
                value={value[key]}
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

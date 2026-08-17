/**
 * What is left of each configured limit, per hop, as progress bars. Reads the
 * `chain` payload's `remaining` map (the hub already did the window math), so
 * this shows exactly what the gate will enforce on the next request.
 */
import type { LLMChainHop, LLMChainRemaining } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

import { Progress } from '@src/components/ui/progress';
import { formatValue } from '@src/components/cost-dashboard/constants';

import { LIMIT_LABELS } from './LimitsEditor';
import type { LimitKey } from './filters-limits-forms';
import { formatUsd, remainingRatio } from './usage-math';

function fmt(key: string, value: number): string {
  if (key.startsWith('cost_usd')) return formatUsd(value);
  if (key.startsWith('tokens')) return formatValue(value, 'tokens');
  return String(value);
}

function tone(ratio: number): string {
  if (ratio <= 0.1) return '[&>div]:bg-destructive';
  if (ratio <= 0.3) return '[&>div]:bg-amber-500';
  return '';
}

export function LimitBar({ limitKey, remaining }: { limitKey: string; remaining: LLMChainRemaining }) {
  const { t } = useLingui();
  const ratio = remainingRatio(remaining);
  const label = LIMIT_LABELS[limitKey as LimitKey];
  const resets = remaining.resets_at ? new Date(remaining.resets_at * 1000).toLocaleString() : null;
  return (
    <div className="space-y-0.5" data-testid={`limit-bar-${limitKey}`}>
      <div className="flex items-baseline justify-between text-xs">
        <span>{label ? t(label) : limitKey}</span>
        <span className="font-mono text-muted-foreground">
          {fmt(limitKey, remaining.used)} / {fmt(limitKey, remaining.limit)}
        </span>
      </div>
      <Progress value={Math.round((1 - ratio) * 100)} className={`h-1.5 ${tone(ratio)}`} />
      {resets && (
        <div className="text-[11px] text-muted-foreground">
          <Trans>resets {resets}</Trans>
        </div>
      )}
    </div>
  );
}

export function LimitsRemaining({ hops }: { hops: readonly LLMChainHop[] }) {
  const withLimits = hops.filter((h) => Object.keys(h.remaining ?? {}).length > 0);
  if (withLimits.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="limits-none">
        <Trans>No limits configured along this chain.</Trans>
      </p>
    );
  }
  return (
    <div className="space-y-4" data-testid="limits-remaining">
      {withLimits.map((hop) => (
        <div key={hop.id} className="space-y-2">
          <div className="text-sm font-medium">{hop.name}</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(hop.remaining).map(([key, r]) => (
              <LimitBar key={key} limitKey={key} remaining={r} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

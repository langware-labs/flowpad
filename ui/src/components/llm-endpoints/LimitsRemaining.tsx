/**
 * What is left of each configured limit, per hop, as progress bars. Reads the
 * `chain` payload's `remaining` map (the hub already did the window math), so
 * this shows exactly what the gate will enforce on the next request.
 *
 * `LimitBar` is the shared presentation of one window — the token plan's budget
 * hero renders its own windows through it, passing its "resets in 4 h" wording
 * and its own test id.
 */
import type { LLMChainHop, LLMChainRemaining } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

import { Progress } from '@src/components/ui/progress';

import { LIMIT_LABELS } from './LimitsEditor';
import type { LimitKey } from './filters-limits-forms';
import { RATIO_TONE } from './tone';
import { formatAmount, ratioTone, usedRatio } from './usage-math';

export interface LimitBarProps {
  limitKey: string;
  remaining: LLMChainRemaining;
  /** Overrides the default "resets <date>" line; `''` hides it entirely. */
  resetsText?: string;
  /** Defaults to `limit-bar-<key>`. */
  testId?: string;
}

export function LimitBar({ limitKey, remaining, resetsText, testId }: LimitBarProps) {
  const { t } = useLingui();
  const used = usedRatio(remaining);
  const label = LIMIT_LABELS[limitKey as LimitKey];
  const resets = remaining.resets_at ? new Date(remaining.resets_at * 1000).toLocaleString() : null;
  return (
    <div className="space-y-0.5" data-testid={testId ?? `limit-bar-${limitKey}`}>
      <div className="flex items-baseline justify-between text-xs">
        <span>{label ? t(label) : limitKey}</span>
        <span className="font-mono text-muted-foreground">
          {formatAmount(limitKey, remaining.used)} / {formatAmount(limitKey, remaining.limit)}
        </span>
      </div>
      <Progress value={Math.round(used * 100)} className={`h-1.5 ${RATIO_TONE[ratioTone(used)].bar}`} />
      {resetsText !== undefined
        ? resetsText !== '' && <div className="text-[11px] text-muted-foreground">{resetsText}</div>
        : resets && (
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

/**
 * The harness modal's budget chip on the managed (hub endpoint) row:
 * "your budget: $3.20 of $5 today" from the `me` headline; the upstream cap
 * when nothing caps me here but something does up the path; "no budget" when
 * nothing caps me at all; nothing when the plan cannot be read.
 */
import { useLingui } from '@lingui/react/macro';

import { Badge } from '@src/components/ui/badge';
import { RATIO_TONE, TONE } from '@src/components/llm-endpoints/tone';

import { headlineFor } from './token-plan-math';
import { useTokenPlan } from './use-token-plan';

export function TokenPlanChip() {
  const { i18n, t } = useLingui();
  const { data, error } = useTokenPlan();
  if (error || !data) return null;
  const me = data.scopes.find((s) => s.kind === 'me');
  if (!me) return null;
  const headline = headlineFor(me, i18n);
  if (!headline.short) {
    return (
      <Badge variant="outline" className={`gap-1 ${TONE.sky}`} data-testid="token-plan-chip">
        {t`no budget`}
      </Badge>
    );
  }
  const short = headline.short;
  return (
    <Badge variant="outline" className={`gap-1 ${RATIO_TONE[headline.tone].badge}`} data-testid="token-plan-chip">
      {headline.caps ?? t`your budget: ${short}`}
    </Badge>
  );
}

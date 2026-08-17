/**
 * Hub home's "Token plan" hero card: my headline ("$1.80 left today"),
 * resets-in, and a 7-day sparkline. Click → the token plan screen. Hidden
 * entirely when the plan cannot be read (no hub, 403, …) — the home must not
 * show a broken card.
 */
import { PageId, ViewType } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';
import { Gauge } from 'lucide-react';

import { CostSparkline } from '@src/components/cost-dashboard/CostSparkline';
import { COST_CHART_COLOR } from '@src/components/llm-endpoints/usage-math';
import { Skeleton } from '@src/components/ui/skeleton';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

import { headlineFor } from './token-plan-math';
import { useTokenPlan } from './use-token-plan';

const CARD =
  'group flex flex-col items-start gap-2 rounded-xl border border-border bg-card p-5 text-start transition-colors hover:bg-accent';

export function TokenPlanCard() {
  const { i18n } = useLingui();
  const { navigation } = useDockNavigation();
  const { data, isLoading, error } = useTokenPlan();
  if (error) return null;
  if (isLoading || !data) {
    return (
      <div className={CARD} data-testid="hub-home-token-plan-loading">
        <Gauge className="h-6 w-6 text-muted-foreground" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-56" />
      </div>
    );
  }
  const me = data.scopes.find((s) => s.kind === 'me') ?? data.scopes[0];
  if (!me) return null;
  const headline = headlineFor(me, i18n);
  const spark = me.series.slice(-7).map((p) => ({ value: p.cost_usd }));
  const parent = me.path.length > 1 ? me.path[1]?.name : undefined;
  return (
    <button
      type="button"
      onClick={() => navigation.openPage(PageId.HUB, ViewType.TOKEN_PLAN)}
      data-testid="hub-home-token-plan"
      className={CARD}
    >
      <div className="flex w-full items-center justify-between">
        <Gauge className="h-6 w-6 text-muted-foreground group-hover:text-foreground" />
        <CostSparkline data={spark} color={COST_CHART_COLOR} />
      </div>
      <span className="text-base font-semibold">
        <Trans>Token plan</Trans>
      </span>
      <span className="text-sm text-muted-foreground" data-testid="hub-home-token-plan-headline">
        {headline.caps ? (
          headline.caps
        ) : headline.text ? (
          <>
            {headline.text}
            {headline.resets && <> · {headline.resets}</>}
          </>
        ) : parent ? (
          <Trans>No limit — draws from {parent}</Trans>
        ) : (
          <Trans>No budget set</Trans>
        )}
      </span>
    </button>
  );
}

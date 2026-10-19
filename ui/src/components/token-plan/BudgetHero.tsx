/**
 * The budget hero for the active scope: the hub's headline as a sentence, then
 * one bar per configured window with "resets in …". Empty states cover "no
 * budget anywhere" (admin gets *Set budget*, others "ask your admin") and
 * "unlimited here, capped upstream".
 *
 * Pure presentation: the wording comes from `headlineFor`, the bars are the
 * endpoint layer's `LimitBar`.
 */
import type { TokenPlanScope } from '@sdk';
import { Trans, useLingui } from '@lingui/react/macro';

import { LimitBar } from '@src/components/llm-endpoints/LimitsRemaining';
import { RATIO_TONE } from '@src/components/llm-endpoints/tone';
import { Button } from '@src/components/ui/button';

import { formatResetsIn, headlineFor } from './token-plan-math';

export interface BudgetHeroProps {
  scope: TokenPlanScope;
  onSetBudget?: () => void;
  now?: Date;
}

export function BudgetHero({ scope, onSetBudget, now }: BudgetHeroProps) {
  const { i18n, t } = useLingui();
  const own = scope.remaining.filter((r) => r.limit > 0);
  const headline = headlineFor(scope, i18n, now);

  if (!headline.text) {
    return (
      <section className="rounded-xl border border-dashed p-5" data-testid="budget-hero-empty">
        <div className="text-base font-semibold">
          <Trans>No budget set</Trans>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {scope.can_configure ? (
            <Trans>Nothing caps this scope yet. Set a daily, weekly or monthly budget in dollars or tokens.</Trans>
          ) : (
            <Trans>Nothing caps this scope yet. Ask your team admin to set a budget.</Trans>
          )}
        </p>
        {scope.can_configure && onSetBudget && (
          <Button size="sm" className="mt-3" onClick={onSetBudget} data-testid="set-budget">
            <Trans>Set budget</Trans>
          </Button>
        )}
      </section>
    );
  }

  return (
    <section className="rounded-xl border bg-card p-5" data-testid="budget-hero">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className={`text-2xl font-semibold ${RATIO_TONE[headline.tone].text}`} data-testid="budget-headline">
            {headline.caps ?? headline.text}
          </div>
          {headline.resets && (
            <div className="text-sm text-muted-foreground" data-testid="budget-resets">
              {headline.resets}
            </div>
          )}
        </div>
        {scope.can_configure && onSetBudget && (
          <Button variant="outline" size="sm" onClick={onSetBudget} data-testid="set-budget">
            <Trans>Set budget</Trans>
          </Button>
        )}
      </div>
      {own.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {own.map((r) => {
            const resets = formatResetsIn(r.resets_at, now);
            return (
              <LimitBar
                key={r.key}
                limitKey={r.key}
                remaining={r}
                resetsText={resets ? t(resets) : ''}
                testId={`budget-bar-${r.key}`}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
